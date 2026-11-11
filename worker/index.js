// Char & Crouton on Cloudflare: the same app and API as server.js, with data in D1 instead of a file.
// The page's files are served straight from public/; this only answers /api/ and /photos/.
import shared from '../lib/shared.js';
import { claim, currentPerson, isFrozen, login, logout, sessionCookie } from './auth.js';
import { handleAdmin } from './admin.js';
import {
  PHOTO_ID, deleteRating, deleteWish, everything, removeOrphanPhotos, saveRating, saveWish, toRestaurant, updateRestaurant,
} from './data.js';

const { BadRequest, exploreArea, fetchWebsite, groupCenter, searchNearby, searchPlaces } = shared;
const SESSION_SECONDS = 90 * 24 * 60 * 60;
// Leaves room under D1's 2 MB per row. Photos are shrunk well below this in the browser.
const MAX_PHOTO_BYTES = 1_900_000;
// The board's small copies are about 10 KB; this just keeps anything else out.
const MAX_THUMB_BYTES = 60_000;
const THUMBS_PER_ASK = 20;
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=15552000',
};

function json(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers },
  });
}

async function readJson(request) {
  // Requiring JSON stops other websites from posting here through a visitor's browser.
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) throw new BadRequest('Expected JSON.');
  const text = await request.text();
  if (text.length > 10000) throw new BadRequest('That is too long.');
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch {
    throw new BadRequest('Expected JSON.');
  }
}

// Only what the page needs: password hashes and sessions never leave the database.
async function view(env, me) {
  return { ...await everything(env), me, frozen: await isFrozen(env) };
}

async function readJpeg(request, maxBytes) {
  // Requiring this type makes other websites' requests fail a browser preflight check.
  if (request.headers.get('Content-Type') !== 'image/jpeg') throw new BadRequest('Photos must be JPEG images.');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > maxBytes) throw new BadRequest('That photo is too large.');
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new BadRequest('Photos must be JPEG images.');
  return bytes;
}

async function savePhoto(env, request) {
  const bytes = await readJpeg(request, MAX_PHOTO_BYTES);
  const id = crypto.randomUUID();
  await env.PHOTOS.batch([
    env.PHOTOS.prepare('INSERT INTO photos (id, bytes) VALUES (?, ?)').bind(id, bytes),
    env.PHOTOS.prepare('INSERT INTO uploads (id, created) VALUES (?, ?)').bind(id, Date.now()),
  ]);
  try {
    await removeOrphanPhotos(env);
  } catch (err) {
    // Tidying up can wait for the next upload.
    console.error(`Could not clear unused photos: ${err.message}`);
  }
  return id;
}

// The first small copy for a photo is kept; it never needs changing afterwards.
async function saveThumb(env, request, id) {
  if (!PHOTO_ID.test(id)) throw new BadRequest('Not found', 404);
  const bytes = await readJpeg(request, MAX_THUMB_BYTES);
  const photo = await env.PHOTOS.prepare('SELECT 1 FROM photos WHERE id = ?').bind(id).first();
  if (!photo) throw new BadRequest('Not found', 404);
  await env.PHOTOS.prepare('INSERT OR IGNORE INTO thumbs (id, bytes) VALUES (?, ?)').bind(id, bytes).run();
}

// Photos from before small copies existed, for a browser to make them.
async function missingThumbs(env) {
  const rows = await env.PHOTOS.prepare('SELECT id FROM photos WHERE id NOT IN (SELECT id FROM thumbs) LIMIT ?').bind(THUMBS_PER_ASK).all();
  return rows.results.map((row) => row.id);
}

const jpeg = (bytes, cache) => new Response(new Uint8Array(bytes), {
  headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': cache, ...SECURITY_HEADERS },
});

async function servePhoto(env, pathname) {
  const name = pathname.slice('/photos/'.length).replace(/\.jpg$/, '');
  const wantsThumb = name.endsWith('.thumb');
  const id = wantsThumb ? name.slice(0, -'.thumb'.length) : name;
  if (!PHOTO_ID.test(id)) return json(404, { error: 'Not found' });
  if (wantsThumb) {
    const thumb = await env.PHOTOS.prepare('SELECT bytes FROM thumbs WHERE id = ?').bind(id).first();
    if (thumb) return jpeg(thumb.bytes, 'private, max-age=31536000, immutable');
  }
  const row = await env.PHOTOS.prepare('SELECT bytes FROM photos WHERE id = ?').bind(id).first();
  if (!row) return json(404, { error: 'Not found' });
  // Without a small copy yet, the full photo stands in, but only briefly so the small one takes over.
  return jpeg(row.bytes, wantsThumb ? 'private, max-age=3600' : 'private, max-age=31536000, immutable');
}

// Fetched the first time someone opens a restaurant on the map, then remembered.
async function findWebsite(env, id) {
  const row = await env.DB.prepare('SELECT * FROM restaurants WHERE id = ?').bind(id).first();
  if (!row) throw new BadRequest('That restaurant no longer exists.');
  if (row.website !== null) return row.website;
  if (!row.place_id || await isFrozen(env)) return '';
  try {
    const website = await fetchWebsite(row.place_id);
    await env.DB.prepare('UPDATE restaurants SET website = ? WHERE id = ?').bind(website, id).run();
    return website;
  } catch (err) {
    console.error(`Website lookup failed: ${err.message}`);
    return '';
  }
}

async function route(request, env, renewed) {
  const url = new URL(request.url);
  const { pathname, searchParams } = url;
  const { method } = request;

  if (pathname.startsWith('/api/admin/')) return handleAdmin(env, request, pathname, json);
  if (pathname === '/api/login' && method === 'POST') {
    const token = await login(env, request, await readJson(request));
    return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(request, token, SESSION_SECONDS) });
  }
  if (pathname === '/api/claim' && method === 'POST') {
    const token = await claim(env, request, await readJson(request));
    return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(request, token, SESSION_SECONDS) });
  }
  if (pathname === '/api/logout' && method === 'POST') {
    await logout(env, request);
    return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(request, '', 0) });
  }

  // All of the app's data is behind sign-in.
  const me = await currentPerson(env, request, renewed);
  if (!me) return json(401, { error: 'Please sign in.' });
  if (method !== 'GET') {
    const frozen = await isFrozen(env);
    if (frozen) return json(503, { error: frozen });
  }

  if (pathname.startsWith('/photos/') && method === 'GET') return servePhoto(env, pathname);
  if (pathname === '/api/state' && method === 'GET') return json(200, await view(env, me));
  if (pathname === '/api/places' && method === 'GET') {
    const restaurants = (await env.DB.prepare('SELECT * FROM restaurants').all()).results.map(toRestaurant);
    try {
      return json(200, await searchPlaces(searchParams, groupCenter(restaurants)));
    } catch (err) {
      console.error(`Place search failed: ${err.message}`);
      return json(502, { error: 'Restaurant search is unavailable right now.' });
    }
  }
  if (pathname === '/api/nearby' && method === 'GET') {
    try {
      return json(200, await searchNearby(searchParams));
    } catch (err) {
      if (err instanceof BadRequest) throw err;
      console.error(`Nearby search failed: ${err.message}`);
      return json(502, { error: 'Nearby search is unavailable right now.' });
    }
  }
  if (pathname === '/api/explore' && method === 'GET') {
    try {
      return json(200, await exploreArea(searchParams));
    } catch (err) {
      if (err instanceof BadRequest) throw err;
      console.error(`Explore search failed: ${err.message}`);
      return json(502, { error: 'Exploring is unavailable right now.' });
    }
  }
  if (pathname === '/api/ratings' && method === 'POST') {
    await saveRating(env, await readJson(request), me);
    return json(200, await view(env, me));
  }
  if (pathname === '/api/photos' && method === 'POST') return json(200, { id: await savePhoto(env, request) });
  if (pathname === '/api/thumbs/missing' && method === 'GET') return json(200, { ids: await missingThumbs(env) });
  if (pathname.startsWith('/api/thumbs/') && method === 'PUT') {
    await saveThumb(env, request, pathname.slice('/api/thumbs/'.length));
    return json(200, { ok: true });
  }
  if (pathname === '/api/wishes' && method === 'POST') {
    await saveWish(env, await readJson(request), me);
    return json(200, await view(env, me));
  }
  const website = /^\/api\/restaurants\/([^/]+)\/website$/.exec(pathname);
  if (website && method === 'GET') return json(200, { website: await findWebsite(env, website[1]) });
  if (pathname.startsWith('/api/restaurants/') && method === 'PATCH') {
    await updateRestaurant(env, pathname.slice('/api/restaurants/'.length), await readJson(request));
    return json(200, await view(env, me));
  }
  if (pathname.startsWith('/api/wishes/') && method === 'DELETE') {
    await deleteWish(env, pathname.slice('/api/wishes/'.length), me);
    return json(200, await view(env, me));
  }
  if (pathname.startsWith('/api/ratings/') && method === 'DELETE') {
    await deleteRating(env, pathname.slice('/api/ratings/'.length), me);
    return json(200, await view(env, me));
  }
  return json(404, { error: 'Not found' });
}

export default {
  async fetch(request, env) {
    // Filled in when using the app renews the sign-in, so the browser keeps its cookie as long.
    const renewed = {};
    try {
      const response = await route(request, env, renewed);
      if (renewed.cookie) response.headers.append('Set-Cookie', renewed.cookie);
      return response;
    } catch (err) {
      if (err instanceof BadRequest) return json(err.status || 400, { error: err.message });
      console.error(err);
      return json(500, { error: 'Something went wrong saving that.' });
    }
  },
};
