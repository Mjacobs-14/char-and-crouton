// Owner tools for the hosted copy of the app.
//   node scripts/host.js token         make a new admin token
//   node scripts/host.js push          upload this computer's data to an empty host
//   node scripts/host.js pull          save a backup of the host's data here
//   node scripts/host.js invite Name   make an invite code on the host
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { randomBytes } = require('node:crypto');

const dataFile = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'ratings.json');
const dataDir = path.dirname(dataFile);
const photoDir = path.join(dataDir, 'photos');
const [command, ...rest] = process.argv.slice(2);

async function connection() {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const url = (process.env.HOST_URL || await prompt.question('Host link (https://...): ')).trim().replace(/\/+$/, '');
  const token = (process.env.ADMIN_TOKEN || await prompt.question('Admin token: ')).trim();
  prompt.close();
  const { protocol, hostname } = new URL(url);
  // Never send the token, passwords or ratings over an unencrypted connection.
  if (protocol !== 'https:' && hostname !== 'localhost') throw new Error('The host link must start with https://');
  const request = async (route, options = {}) => {
    const res = await fetch(url + route, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `The host answered with status ${res.status}.`);
    return body;
  };
  return request;
}

function localPhotos() {
  const photos = {};
  if (!fs.existsSync(photoDir)) return photos;
  for (const file of fs.readdirSync(photoDir)) {
    photos[file.replace(/\.jpg$/, '')] = fs.readFileSync(path.join(photoDir, file)).toString('base64');
  }
  return photos;
}

const comparable = ({ restaurants, ratings, people, wishes, accounts }) => JSON.stringify({ restaurants, ratings, people, wishes, accounts });

async function push() {
  if (!fs.existsSync(dataFile)) throw new Error('There is no local data to upload.');
  const local = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const photos = localPhotos();
  const request = await connection();
  const result = await request('/api/admin/import', { method: 'POST', body: JSON.stringify({ data: local, photos }) });
  const copy = await request('/api/admin/export');
  const matches = comparable(copy.data) === comparable(local)
    && Object.keys(photos).every((id) => copy.photos[id] === photos[id]);
  if (!matches) throw new Error('The upload finished, but the host\'s copy does not match. Keep using this computer\'s copy.');
  console.log(`Uploaded and verified: ${result.ratings} ratings, ${result.restaurants} restaurants, ${result.accounts} accounts, ${result.photos} photos.`);
}

async function pull() {
  const request = await connection();
  const { data, photos } = await request('/api/admin/export');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dataDir, 'backups', `host_${stamp}`);
  fs.mkdirSync(path.join(target, 'photos'), { recursive: true });
  fs.writeFileSync(path.join(target, path.basename(dataFile)), JSON.stringify(data, null, 2));
  for (const [id, base64] of Object.entries(photos)) fs.writeFileSync(path.join(target, 'photos', `${id}.jpg`), Buffer.from(base64, 'base64'));
  console.log(`Saved ${data.ratings.length} ratings and ${Object.keys(photos).length} photos to ${target}`);
}

async function invite() {
  const name = rest.join(' ').trim();
  if (!name) throw new Error('Usage: node scripts/host.js invite Name');
  const request = await connection();
  const { person, code, days } = await request('/api/admin/invite', { method: 'POST', body: JSON.stringify({ name }) });
  console.log(`\nInvite for ${person}\nCode: ${code}\nWorks once, for ${days} days. Send it privately.\n`);
}

const commands = {
  token: async () => console.log(randomBytes(32).toString('hex')),
  push,
  pull,
  invite,
};

(commands[command] || (async () => { throw new Error('Use one of: token, push, pull, invite'); }))()
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
