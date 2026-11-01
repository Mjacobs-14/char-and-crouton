// Owner-only tools for a hosted copy: first upload, off-site backups and invites.
// They only exist when the host sets a long ADMIN_TOKEN, and the token never appears in the code.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, timingSafeEqual } = require('node:crypto');
const { createInvite } = require('./invites');

const MIN_TOKEN = 32;
const MAX_BODY_BYTES = 150 * 1024 * 1024;
const MAX_FAILURES = 10;
const LOCK_MS = 15 * 60 * 1000;
const PHOTO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256 = (text) => createHash('sha256').update(text).digest();

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error('too large');
        error.tooLarge = true;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

module.exports = function createAdmin({ db, commit, dataFile, photoDir, sendJson }) {
  let failures = 0;
  let lockedUntil = 0;

  function authorized(req) {
    const given = (req.headers.authorization || '').replace(/^Bearer /, '');
    return timingSafeEqual(sha256(given), sha256(process.env.ADMIN_TOKEN));
  }

  const isEmpty = () => !db.ratings.length && !db.restaurants.length && !db.accounts.length;

  function importData(res, bundle) {
    const { data, photos = {} } = bundle;
    const valid = data && ['restaurants', 'ratings', 'people', 'wishes', 'accounts'].every((key) => Array.isArray(data[key]));
    if (!valid) {
      sendJson(res, 400, { error: 'That upload is missing data.' });
      return;
    }
    const decoded = Object.entries(photos).map(([id, base64]) => [id, Buffer.from(base64, 'base64')]);
    const badPhoto = decoded.find(([id, bytes]) => !PHOTO_ID.test(id) || bytes[0] !== 0xff || bytes[1] !== 0xd8);
    if (badPhoto) {
      sendJson(res, 400, { error: 'One of the photos is not a valid JPEG.' });
      return;
    }
    fs.mkdirSync(photoDir, { recursive: true });
    for (const [id, bytes] of decoded) fs.writeFileSync(path.join(photoDir, `${id}.jpg`), bytes);
    commit(() => {
      const { restaurants, ratings, people, wishes, accounts } = data;
      // Sign-ins from the old address are worthless here, so everyone signs in afresh.
      Object.assign(db, { restaurants, ratings, people, wishes, accounts, sessions: [] });
    });
    sendJson(res, 200, { ratings: db.ratings.length, restaurants: db.restaurants.length, accounts: db.accounts.length, photos: decoded.length });
  }

  function exportData(res) {
    const photos = {};
    if (fs.existsSync(photoDir)) {
      for (const file of fs.readdirSync(photoDir)) {
        photos[file.replace(/\.jpg$/, '')] = fs.readFileSync(path.join(photoDir, file)).toString('base64');
      }
    }
    const { sessions, ...data } = db;
    sendJson(res, 200, { data, photos });
  }

  function makeInvite(res, name) {
    const typed = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
    if (!typed || typed.length > 30) {
      sendJson(res, 400, { error: 'Enter a name of up to 30 characters.' });
      return;
    }
    const person = db.people.find((other) => other.toLowerCase() === typed.toLowerCase()) || typed;
    sendJson(res, 200, { person, ...createInvite(dataFile, person) });
  }

  return async function handle(req, res, pathname) {
    // Without a proper token set, these routes simply don't exist.
    if (!process.env.ADMIN_TOKEN || process.env.ADMIN_TOKEN.length < MIN_TOKEN) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    if (Date.now() < lockedUntil) {
      sendJson(res, 429, { error: 'Too many tries. Please wait 15 minutes.' });
      return;
    }
    if (!authorized(req)) {
      failures += 1;
      if (failures >= MAX_FAILURES) {
        failures = 0;
        lockedUntil = Date.now() + LOCK_MS;
      }
      sendJson(res, 401, { error: 'That admin token is not right.' });
      return;
    }
    failures = 0;

    if (pathname === '/api/admin/export' && req.method === 'GET') {
      exportData(res);
      return;
    }
    if (req.method !== 'POST' || !(req.headers['content-type'] || '').startsWith('application/json')) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      sendJson(res, err.tooLarge ? 413 : 400, { error: err.tooLarge ? 'That upload is too large.' : 'Expected JSON.' });
      return;
    }
    if (pathname === '/api/admin/import') {
      // A one-way door: an upload can never overwrite ratings already on the host.
      if (!isEmpty()) sendJson(res, 409, { error: 'The host already has data, so nothing was changed.' });
      else importData(res, body);
    } else if (pathname === '/api/admin/invite') {
      makeInvite(res, body.name);
    } else {
      sendJson(res, 404, { error: 'Not found' });
    }
  };
};
