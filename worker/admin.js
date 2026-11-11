// Owner-only tools, matching lib/admin.js so scripts/host.js works with either version.
// They only exist when the ADMIN_TOKEN secret is set.
import shared from '../lib/shared.js';
import { createInvite, sameText, sha256 } from './auth.js';
import { PHOTO_ID, everything } from './data.js';

const { BadRequest } = shared;
const MIN_TOKEN = 32;
const MAX_PHOTO_BYTES = 1_900_000;
const ADMIN_LOCK_KEY = 'admin';
const MAX_ADMIN_FAILURES = 10;
const LOCK_MS = 15 * 60 * 1000;
// D1 limits the work per batch, so big uploads go in pieces.
const BATCH_SIZE = 50;

async function authorize(env, request) {
  const lock = await env.DB.prepare('SELECT count, until FROM failures WHERE key = ?').bind(ADMIN_LOCK_KEY).first();
  if (lock && lock.count >= MAX_ADMIN_FAILURES && Date.now() < lock.until) {
    throw new BadRequest('Too many tries. Please wait 15 minutes.', 429);
  }
  const given = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (sameText(await sha256(given), await sha256(env.ADMIN_TOKEN))) return;
  await env.DB.prepare(`INSERT INTO failures (key, count, until) VALUES (?, 1, ?)
    ON CONFLICT (key) DO UPDATE SET count = count + 1, until = excluded.until`).bind(ADMIN_LOCK_KEY, Date.now() + LOCK_MS).run();
  throw new BadRequest('That admin token is not right.', 401);
}

async function importData(env, body) {
  const { data } = body;
  const valid = data && ['restaurants', 'ratings', 'people', 'wishes', 'accounts'].every((key) => Array.isArray(data[key]));
  if (!valid) throw new BadRequest('That upload is missing data.');
  const counts = await env.DB.prepare(`SELECT (SELECT count(*) FROM restaurants) + (SELECT count(*) FROM ratings)
    + (SELECT count(*) FROM accounts) AS total`).first();
  // A one-way door: an upload can never overwrite ratings already here.
  if (counts.total > 0) throw new BadRequest('The host already has data, so nothing was changed.', 409);
  const statements = [
    ...data.restaurants.map((r) => env.DB.prepare('INSERT INTO restaurants (id, name, area, place_id, address, lat, lon, website) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(r.id, r.name, r.area || '', r.placeId ?? null, r.placeId ? r.address ?? '' : null, r.lat ?? null, r.lon ?? null, r.website ?? null)),
    ...data.ratings.map((r) => env.DB.prepare('INSERT INTO ratings (id, restaurant_id, dish, rater, score, note, photo, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(r.id, r.restaurantId, r.dish, r.rater, r.score, r.note || '', r.photo ?? null, r.updatedAt)),
    ...data.people.map((name) => env.DB.prepare('INSERT INTO people (name) VALUES (?)').bind(name)),
    ...data.wishes.map((w) => env.DB.prepare('INSERT INTO wishes (id, restaurant_id, person, note, added_at) VALUES (?, ?, ?, ?, ?)')
      .bind(w.id, w.restaurantId, w.person, w.note || '', w.addedAt)),
    // Kept so each person keeps their name, but passwords from the home version need setting again here.
    ...data.accounts.map((a) => env.DB.prepare('INSERT INTO accounts (person, password) VALUES (?, ?)').bind(a.person, a.password)),
  ];
  for (let i = 0; i < statements.length; i += BATCH_SIZE) await env.DB.batch(statements.slice(i, i + BATCH_SIZE));
  return { ratings: data.ratings.length, restaurants: data.restaurants.length, accounts: data.accounts.length };
}

async function exportData(env) {
  const [data, accounts, photos] = await Promise.all([
    everything(env),
    env.DB.prepare('SELECT person, password FROM accounts ORDER BY rowid').all(),
    env.PHOTOS.prepare('SELECT id FROM photos ORDER BY rowid').all(),
  ]);
  // Photos are fetched one at a time, so a big collection can't run the worker out of memory.
  return { data: { ...data, accounts: accounts.results }, photoIds: photos.results.map((row) => row.id) };
}

export async function handleAdmin(env, request, pathname, json) {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < MIN_TOKEN) return json(404, { error: 'Not found' });
  await authorize(env, request);
  const photo = /^\/api\/admin\/photos\/([0-9a-f-]+)$/.exec(pathname);
  if (photo) {
    if (!PHOTO_ID.test(photo[1])) return json(404, { error: 'Not found' });
    if (request.method === 'GET') {
      const row = await env.PHOTOS.prepare('SELECT bytes FROM photos WHERE id = ?').bind(photo[1]).first();
      return row
        ? new Response(new Uint8Array(row.bytes), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' } })
        : json(404, { error: 'Not found' });
    }
    if (request.method === 'PUT') {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length > MAX_PHOTO_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new BadRequest('That photo is not a JPEG under 1.9 MB.');
      await env.PHOTOS.prepare('INSERT OR REPLACE INTO photos (id, bytes) VALUES (?, ?)').bind(photo[1], bytes).run();
      return json(200, { ok: true });
    }
  }
  if (pathname === '/api/admin/export' && request.method === 'GET') return json(200, await exportData(env));
  if (request.method !== 'POST' || !(request.headers.get('Content-Type') || '').startsWith('application/json')) {
    return json(404, { error: 'Not found' });
  }
  const body = await request.json().catch(() => {
    throw new BadRequest('Expected JSON.');
  });
  if (pathname === '/api/admin/import') return json(200, await importData(env, body));
  if (pathname === '/api/admin/invite') {
    const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > 30) throw new BadRequest('Enter a name of up to 30 characters.');
    return json(200, await createInvite(env, name));
  }
  if (pathname === '/api/admin/freeze') {
    const message = typeof body.message === 'string' ? body.message.trim().slice(0, 300) : '';
    if (message) await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('frozen', ?)").bind(message).run();
    else await env.DB.prepare("DELETE FROM settings WHERE key = 'frozen'").run();
    return json(200, { frozen: message || null });
  }
  return json(404, { error: 'Not found' });
}
