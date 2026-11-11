// Owner tools for the hosted copy of the app. Works with either the home server or Cloudflare.
//   node scripts/host.js token          make a new admin token
//   node scripts/host.js push           upload this computer's data to an empty host
//   node scripts/host.js pull           save a backup of the host's data here
//   node scripts/host.js invite Name    make an invite code on the host
//   node scripts/host.js freeze "msg"   pause all changes on the host ("off" to resume)
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
  const send = async (route, options = {}) => {
    const res = await fetch(url + route, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `The host answered with status ${res.status}.`);
    }
    return res;
  };
  return {
    json: async (route, body) => (await send(route, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {})).json(),
    getPhoto: async (id) => Buffer.from(await (await send(`/api/admin/photos/${id}`)).arrayBuffer()),
    putPhoto: (id, bytes) => send(`/api/admin/photos/${id}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: bytes }),
  };
}

const localPhotoIds = () => (fs.existsSync(photoDir) ? fs.readdirSync(photoDir).map((file) => file.replace(/\.jpg$/, '')) : []);
const comparable = ({ restaurants, ratings, people, wishes, accounts }) => JSON.stringify({ restaurants, ratings, people, wishes, accounts });

async function push() {
  if (!fs.existsSync(dataFile)) throw new Error('There is no local data to upload.');
  const local = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const host = await connection();
  const result = await host.json('/api/admin/import', { data: local });
  const photoIds = localPhotoIds();
  for (const id of photoIds) await host.putPhoto(id, fs.readFileSync(path.join(photoDir, `${id}.jpg`)));
  // Read everything back and compare, so a partial upload can't go unnoticed.
  const copy = await host.json('/api/admin/export');
  let matches = comparable(copy.data) === comparable(local) && photoIds.every((id) => copy.photoIds.includes(id));
  for (const id of photoIds) {
    if (matches) matches = (await host.getPhoto(id)).equals(fs.readFileSync(path.join(photoDir, `${id}.jpg`)));
  }
  if (!matches) throw new Error('The upload finished, but the host\'s copy does not match. Keep using this computer\'s copy.');
  console.log(`Uploaded and verified: ${result.ratings} ratings, ${result.restaurants} restaurants, ${result.accounts} accounts, ${photoIds.length} photos.`);
}

async function pull() {
  const host = await connection();
  const { data, photoIds } = await host.json('/api/admin/export');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dataDir, 'backups', `host_${stamp}`);
  fs.mkdirSync(path.join(target, 'photos'), { recursive: true });
  for (const id of photoIds) fs.writeFileSync(path.join(target, 'photos', `${id}.jpg`), await host.getPhoto(id));
  fs.writeFileSync(path.join(target, path.basename(dataFile)), JSON.stringify(data, null, 2));
  console.log(`Saved ${data.ratings.length} ratings and ${photoIds.length} photos to ${target}`);
}

async function invite() {
  const name = rest.join(' ').trim();
  if (!name) throw new Error('Usage: node scripts/host.js invite Name');
  const host = await connection();
  const { person, code, days } = await host.json('/api/admin/invite', { name });
  console.log(`\nInvite for ${person}\nCode: ${code}\nWorks once, for ${days} days. Send it privately.\n`);
}

async function freeze() {
  const message = rest.join(' ').trim();
  if (!message) throw new Error('Usage: node scripts/host.js freeze "We\'ve moved: https://..."   or   freeze off');
  const host = await connection();
  const { frozen } = await host.json('/api/admin/freeze', { message: message === 'off' ? '' : message });
  console.log(frozen ? 'Frozen. Nobody can post or change anything until you run: node scripts/host.js freeze off' : 'Unfrozen. Ratings can be posted again.');
}

const commands = {
  token: async () => console.log(randomBytes(32).toString('hex')),
  push,
  pull,
  invite,
  freeze,
};

(commands[command] || (async () => { throw new Error('Use one of: token, push, pull, invite, freeze'); }))()
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
