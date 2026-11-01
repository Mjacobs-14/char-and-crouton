// Char & Crouton: a tiny, dependency-free server. Ratings live in one JSON file.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const createAuth = require('./lib/auth');
const { automaticBackup } = require('./lib/backup');
const createAdmin = require('./lib/admin');

const PORT = Number(process.env.PORT) || 4173;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'ratings.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PHOTO_DIR = path.join(path.dirname(DATA_FILE), 'photos');
const FROZEN_FILE = path.join(path.dirname(DATA_FILE), 'FROZEN');
const PHOTO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const PHOTON_HEADERS = { 'User-Agent': 'CharAndCrouton/1.0' };
const DISHES = ['burger', 'caesar'];
// Only needs the map, fonts and map library from elsewhere. Scripts can't run from anywhere else.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: blob: https://tile.openstreetmap.org https://unpkg.com",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const PLACES_URL = 'https://photon.komoot.io/api/';
const PLACES_REVERSE_URL = 'https://photon.komoot.io/reverse';
const PLACE_TAGS = ['restaurant', 'fast_food', 'pub', 'bar', 'cafe', 'food_court', 'biergarten'];
const US_STATES = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT',
  Delaware: 'DE', 'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL',
  Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD',
  Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE',
  Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC',
  'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI',
  'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA',
  Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
};

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { restaurants: [], ratings: [] };
    // Never start over a corrupt file: an empty save would destroy everyone's ratings.
    console.error(`Could not read ${DATA_FILE}: ${err.message}`);
    process.exit(1);
  }
}

const db = load();
if (!db.people) db.people = [];
if (!db.wishes) db.wishes = [];

function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  // OneDrive and antivirus can hold the file for a moment, so give them a few chances.
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(tmp, DATA_FILE);
      return;
    } catch (err) {
      if (attempt === 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

// Runs a change and saves it, or leaves everything as it was. Otherwise a failed
// save would report an error yet keep showing the change until the next restart.
function commit(change) {
  const before = JSON.stringify(db);
  let afterSave;
  try {
    afterSave = change();
    save();
  } catch (err) {
    Object.assign(db, JSON.parse(before));
    throw err;
  }
  if (afterSave) afterSave();
}

const clean = (value, max) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

class BadRequest extends Error {}

const admin = createAdmin({ db, commit, dataFile: DATA_FILE, photoDir: PHOTO_DIR, sendJson });
const auth = createAuth({ db, commit, dataFile: DATA_FILE, BadRequest, isFrozen: () => Boolean(frozenMessage()) });

function frozenMessage() {
  try {
    return fs.readFileSync(FROZEN_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

// Only what the page needs: password hashes and sessions must never leave the server.
function view(person) {
  const { restaurants, ratings, people, wishes } = db;
  return { restaurants, ratings, people, wishes, me: person, frozen: frozenMessage() };
}

function isValidScore(score) {
  if (typeof score !== 'number' || score < 1 || score > 10) return false;
  return Math.abs(score * 10 - Math.round(score * 10)) < 1e-9;
}

function placeDetails(input) {
  const placeId = clean(input.placeId, 40);
  if (!placeId) return {};
  const lat = Number(input.lat);
  const lon = Number(input.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new BadRequest('That place has no location.');
  return { placeId, address: clean(input.address, 120), lat, lon };
}

function findOrCreateRestaurant(input) {
  if (input && input.id) {
    const existing = db.restaurants.find((r) => r.id === input.id);
    if (!existing) throw new BadRequest('That restaurant no longer exists.');
    return existing;
  }
  const name = clean(input && input.name, 80);
  const area = clean(input && input.area, 60);
  if (!name) throw new BadRequest('Pick or name a restaurant.');
  const details = placeDetails(input);
  const { placeId } = details;
  const samePlace = placeId && db.restaurants.find((r) => r.placeId === placeId);
  if (samePlace) return samePlace;
  // Two looked-up places can share a name and city (chains), but a hand-typed entry can't.
  const existing = db.restaurants.find(
    (r) => same(r.name, name) && same(r.area, area) && (!r.placeId || !placeId),
  );
  if (existing) return Object.assign(existing, details);
  const created = { id: randomUUID(), name, area, ...details };
  db.restaurants.push(created);
  return created;
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function coordsFrom(params) {
  const lat = Number(params.get('lat'));
  const lon = Number(params.get('lon'));
  return params.has('lat') && params.has('lon') && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

// Without a location, results are worldwide. Use where the person is right now
// if the browser shared it, otherwise where this group's restaurants are.
function searchCenter(params) {
  const here = coordsFrom(params);
  if (here) return here;
  const located = db.restaurants.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
  return located.length ? { lat: median(located.map((r) => r.lat)), lon: median(located.map((r) => r.lon)) } : null;
}

function metersBetween(a, b) {
  const rad = (degrees) => (degrees * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(h));
}

async function searchNearby(params) {
  const here = coordsFrom(params);
  if (!here) throw new BadRequest('Nearby search needs a location.');
  const url = new URL(PLACES_REVERSE_URL);
  url.searchParams.set('lat', here.lat);
  url.searchParams.set('lon', here.lon);
  url.searchParams.set('limit', '8');
  url.searchParams.set('radius', '1');
  for (const tag of PLACE_TAGS) url.searchParams.append('osm_tag', `amenity:${tag}`);
  const response = await fetch(url, { headers: PHOTON_HEADERS, signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`Place search returned ${response.status}`);
  const { features } = await response.json();
  return features
    .filter((f) => f.properties.name)
    .map(toPlace)
    .map((place) => ({ ...place, meters: Math.round(metersBetween(here, place)) }))
    .sort((a, b) => a.meters - b.meters);
}

function toPlace(feature) {
  const p = feature.properties;
  const address = [p.housenumber, p.street].filter(Boolean).join(' ');
  // OpenStreetMap mixes "IL" and "Illinois"; one spelling keeps the location filter tidy.
  const state = p.countrycode === 'US' ? US_STATES[p.state] || p.state : p.state;
  return {
    placeId: `osm:${p.osm_type}${p.osm_id}`,
    name: p.name || address,
    isVenue: p.osm_key === 'amenity',
    address,
    area: [p.city || p.town || p.district || p.county || p.name, state].filter(Boolean).join(', '),
    lat: feature.geometry.coordinates[1],
    lon: feature.geometry.coordinates[0],
  };
}

async function searchPlaces(params) {
  const query = clean(params.get('q'), 80);
  if (query.length < 2) return [];
  const url = new URL(PLACES_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '6');
  // Addresses are allowed when pinning a restaurant OpenStreetMap doesn't list.
  if (params.get('addresses') !== '1') {
    for (const tag of PLACE_TAGS) url.searchParams.append('osm_tag', `amenity:${tag}`);
  }
  const center = searchCenter(params);
  if (center) {
    url.searchParams.set('lat', center.lat);
    url.searchParams.set('lon', center.lon);
  }
  const response = await fetch(url, {
    headers: { 'User-Agent': 'CharAndCrouton/1.0' },
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`Place search returned ${response.status}`);
  const { features } = await response.json();
  return features.filter((f) => f.properties.name || f.properties.street).map(toPlace);
}

function normalizeWebsite(raw) {
  if (!raw) return '';
  const first = raw.split(';')[0].trim();
  try {
    const url = new URL(/^https?:\/\//i.test(first) ? first : `https://${first}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href.slice(0, 300) : '';
  } catch {
    return '';
  }
}

// Fetched the first time someone opens a restaurant on the map, then remembered.
async function findWebsite(restaurant) {
  if (restaurant.website !== undefined) return restaurant.website;
  if (frozenMessage()) return '';
  const match = /^osm:([NWR])(\d+)$/.exec(restaurant.placeId || '');
  if (!match) return '';
  const type = { N: 'node', W: 'way', R: 'relation' }[match[1]];
  const response = await fetch(`https://api.openstreetmap.org/api/0.6/${type}/${match[2]}.json`, {
    headers: { 'User-Agent': 'CharAndCrouton/1.0' },
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`OpenStreetMap returned ${response.status}`);
  const { elements } = await response.json();
  const tags = (elements[0] && elements[0].tags) || {};
  const website = normalizeWebsite(tags.website || tags['contact:website'] || tags.url);
  commit(() => { db.restaurants.find((r) => r.id === restaurant.id).website = website; });
  return website;
}

// Each person has one rating per dish per restaurant, so rating again updates it.
function saveRating(body, rater) {
  const note = clean(body.note, 280);
  if (!DISHES.includes(body.dish)) throw new BadRequest('Dish must be a burger or a caesar.');
  if (!isValidScore(body.score)) throw new BadRequest('Score must be 1.0 to 10.0, in tenths.');
  if (body.photo && !(PHOTO_ID.test(body.photo) && fs.existsSync(photoPath(body.photo)))) {
    throw new BadRequest('That photo did not upload. Please try it again.');
  }

  const restaurant = findOrCreateRestaurant(body.restaurant);
  const score = Math.round(body.score * 10) / 10;
  const existing = db.ratings.find(
    (r) => r.restaurantId === restaurant.id && r.dish === body.dish && same(r.rater, rater),
  );
  // Leaving photo out keeps the current one; null removes it.
  const photoChange = body.photo === undefined ? {} : { photo: body.photo };
  let replaced = null;
  if (existing) {
    const oldPhoto = existing.photo;
    Object.assign(existing, { score, note, updatedAt: new Date().toISOString() }, photoChange);
    if (oldPhoto && oldPhoto !== existing.photo) replaced = oldPhoto;
  } else {
    db.ratings.push({
      ...photoChange,
      id: randomUUID(),
      restaurantId: restaurant.id,
      dish: body.dish,
      rater,
      score,
      note,
      updatedAt: new Date().toISOString(),
    });
  }
  // Having eaten there, it's no longer on this person's want-to-try list.
  db.wishes = db.wishes.filter((w) => !(w.restaurantId === restaurant.id && w.person === rater));
  return () => { if (replaced) removePhoto(replaced); };
}

function photoPath(id) {
  return path.join(PHOTO_DIR, `${id}.jpg`);
}

function removePhoto(id) {
  fs.rm(photoPath(id), { force: true }, (err) => {
    if (err) console.error(`Could not remove photo ${id}: ${err.message}`);
  });
}

function savePhoto(bytes) {
  // The browser shrinks photos to JPEG before uploading, so anything else isn't ours.
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new BadRequest('Photos must be JPEG images.');
  }
  const id = randomUUID();
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  fs.writeFileSync(photoPath(id), bytes);
  return id;
}

function removeRestaurantIfUnused(id) {
  const used = db.ratings.some((r) => r.restaurantId === id) || db.wishes.some((w) => w.restaurantId === id);
  if (!used) db.restaurants = db.restaurants.filter((r) => r.id !== id);
}

function saveWish(body, person) {
  const restaurant = findOrCreateRestaurant(body.restaurant);
  const note = clean(body.note, 280);
  const existing = db.wishes.find((w) => w.restaurantId === restaurant.id && w.person === person);
  if (existing) existing.note = note;
  else db.wishes.push({ id: randomUUID(), restaurantId: restaurant.id, person, note, addedAt: new Date().toISOString() });
}

function deleteWish(id) {
  const index = db.wishes.findIndex((w) => w.id === id);
  if (index === -1) return false;
  const [removed] = db.wishes.splice(index, 1);
  removeRestaurantIfUnused(removed.restaurantId);
  return true;
}

function updateRestaurant(id, body) {
  const restaurant = db.restaurants.find((r) => r.id === id);
  if (!restaurant) throw new BadRequest('That restaurant no longer exists.');
  const name = clean(body.name, 80);
  const area = clean(body.area, 60);
  if (!name) throw new BadRequest('Restaurants need a name.');
  const duplicate = db.restaurants.find(
    (r) => r.id !== id && same(r.name, name) && same(r.area, area) && (r.address || '') === (restaurant.address || ''),
  );
  if (duplicate) throw new BadRequest('There is already a restaurant with that name and location.');
  const details = placeDetails(body.place || {});
  if (details.placeId && details.placeId !== restaurant.placeId) {
    if (db.restaurants.some((r) => r.id !== id && r.placeId === details.placeId)) {
      throw new BadRequest('Another restaurant is already pinned to that place.');
    }
    delete restaurant.website;
  }
  Object.assign(restaurant, { name, area }, details);
}

function deleteRating(id) {
  const index = db.ratings.findIndex((r) => r.id === id);
  if (index === -1) return false;
  const [removed] = db.ratings.splice(index, 1);
  // Drop restaurants nobody references, so a typo'd name disappears with its rating.
  removeRestaurantIfUnused(removed.restaurantId);
  return () => { if (removed.photo) removePhoto(removed.photo); };
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    // Requiring JSON stops other websites from posting here through a visitor's browser.
    if (!(req.headers['content-type'] || '').startsWith('application/json')) {
      reject(new BadRequest('Expected JSON.'));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 10000) {
        reject(new BadRequest('That is too long.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
        resolve(parsed);
      } catch {
        reject(new BadRequest('Expected JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function readPhotoBody(req) {
  return new Promise((resolve, reject) => {
    // Requiring this type makes other websites' requests fail a browser preflight check.
    if (req.headers['content-type'] !== 'image/jpeg') {
      reject(new BadRequest('Photos must be JPEG images.'));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_PHOTO_BYTES) {
        reject(new BadRequest('That photo is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function servePhoto(pathname, res) {
  const id = pathname.slice('/photos/'.length).replace(/\.jpg$/, '');
  if (!PHOTO_ID.test(id)) {
    res.writeHead(404).end('Not found');
    return;
  }
  fs.readFile(photoPath(id), (err, contents) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(contents);
  });
}

function serveStatic(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
  const file = path.resolve(PUBLIC_DIR, relative);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(404).end('Not found');
    return;
  }
  fs.readFile(file, (err, contents) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(contents);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    if (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    }
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    if (pathname.startsWith('/api/admin/')) {
      await admin(req, res, pathname);
      return;
    }
    if (pathname === '/api/login' && req.method === 'POST') {
      await auth.login(req, res, await readJson(req));
      sendJson(res, 200, { ok: true });
      return;
    }
    if (pathname === '/api/claim' && req.method === 'POST') {
      await auth.claim(req, res, await readJson(req));
      sendJson(res, 200, { ok: true });
      return;
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      auth.logout(req, res);
      sendJson(res, 200, { ok: true });
      return;
    }
    // The app's files are public, but all of its data is behind sign-in.
    const me = auth.currentPerson(req);
    if (!me && (pathname.startsWith('/api/') || pathname.startsWith('/photos/'))) {
      sendJson(res, 401, { error: 'Please sign in.' });
      return;
    }
    if (pathname.startsWith('/api/') && req.method !== 'GET' && frozenMessage()) {
      sendJson(res, 503, { error: frozenMessage() });
      return;
    }
    if (pathname === '/api/state' && req.method === 'GET') {
      sendJson(res, 200, view(me));
    } else if (pathname === '/api/places' && req.method === 'GET') {
      try {
        sendJson(res, 200, await searchPlaces(searchParams));
      } catch (err) {
        console.error(`Place search failed: ${err.message}`);
        sendJson(res, 502, { error: 'Restaurant search is unavailable right now.' });
      }
    } else if (pathname === '/api/ratings' && req.method === 'POST') {
      const body = await readJson(req);
      commit(() => saveRating(body, me));
      sendJson(res, 200, view(me));
    } else if (pathname === '/api/nearby' && req.method === 'GET') {
      try {
        sendJson(res, 200, await searchNearby(searchParams));
      } catch (err) {
        if (err instanceof BadRequest) throw err;
        console.error(`Nearby search failed: ${err.message}`);
        sendJson(res, 502, { error: 'Nearby search is unavailable right now.' });
      }
    } else if (pathname === '/api/photos' && req.method === 'POST') {
      sendJson(res, 200, { id: savePhoto(await readPhotoBody(req)) });
    } else if (pathname === '/api/wishes' && req.method === 'POST') {
      const body = await readJson(req);
      commit(() => { saveWish(body, me); });
      sendJson(res, 200, view(me));
    } else if (pathname.startsWith('/api/wishes/') && req.method === 'DELETE') {
      const id = pathname.slice('/api/wishes/'.length);
      const wish = db.wishes.find((w) => w.id === id);
      if (!wish) {
        sendJson(res, 404, { error: 'That is already off the list.' });
      } else if (wish.person !== me) {
        sendJson(res, 403, { error: 'You can only change your own list.' });
      } else {
        commit(() => { deleteWish(id); });
        sendJson(res, 200, view(me));
      }
    } else if (pathname.startsWith('/photos/') && req.method === 'GET') {
      servePhoto(pathname, res);
    } else if (/^\/api\/restaurants\/[^/]+\/website$/.test(pathname) && req.method === 'GET') {
      const restaurant = db.restaurants.find((r) => r.id === pathname.split('/')[3]);
      if (!restaurant) throw new BadRequest('That restaurant no longer exists.');
      try {
        sendJson(res, 200, { website: await findWebsite(restaurant) });
      } catch (err) {
        console.error(`Website lookup failed: ${err.message}`);
        sendJson(res, 200, { website: '' });
      }
    } else if (pathname.startsWith('/api/restaurants/') && req.method === 'PATCH') {
      const body = await readJson(req);
      commit(() => updateRestaurant(pathname.slice('/api/restaurants/'.length), body));
      sendJson(res, 200, view(me));
    } else if (pathname.startsWith('/api/ratings/') && req.method === 'DELETE') {
      const id = pathname.slice('/api/ratings/'.length);
      const rating = db.ratings.find((r) => r.id === id);
      if (!rating) {
        sendJson(res, 404, { error: 'That rating is already gone.' });
      } else if (rating.rater !== me) {
        sendJson(res, 403, { error: 'You can only delete your own ratings.' });
      } else {
        commit(() => deleteRating(id));
        sendJson(res, 200, view(me));
      }
    } else if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Not found' });
    } else {
      serveStatic(pathname, res);
    }
  } catch (err) {
    if (err instanceof BadRequest || err instanceof URIError) {
      sendJson(res, err.status || 400, { error: err.message });
    } else {
      console.error(err);
      sendJson(res, 500, { error: 'Something went wrong saving that.' });
    }
  }
});

function runAutomaticBackup() {
  try {
    automaticBackup(DATA_FILE);
  } catch (err) {
    console.error(`Automatic backup failed: ${err.message}`);
  }
}
runAutomaticBackup();
setInterval(runAutomaticBackup, 60 * 60 * 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nChar & Crouton is open.\n\n  On this computer:  http://localhost:${PORT}`);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses) {
      if (address.family === 'IPv4' && !address.internal) {
        console.log(`  Friends on Wi-Fi:  http://${address.address}:${PORT}`);
      }
    }
  }
  console.log('\nPress Ctrl+C to close.\n');
});
