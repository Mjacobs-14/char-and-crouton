// One-time invite codes. They live in their own file so `npm run invite` can add
// one while the app is running without racing the app's copy of the ratings.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomInt } = require('node:crypto');

const INVITE_DAYS = 7;
// No 0/O or 1/I/L, since these get read off a screen and typed on a phone.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const invitesFile = (dataFile) => path.join(path.dirname(dataFile), 'invites.json');
const normalizeCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = (code) => createHash('sha256').update(normalizeCode(code)).digest('hex');

function readInvites(dataFile) {
  try {
    return JSON.parse(fs.readFileSync(invitesFile(dataFile), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function writeInvites(dataFile, invites) {
  const file = invitesFile(dataFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(invites, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

// Only the hash is stored, so the file alone can't be used to claim a name.
function createInvite(dataFile, person) {
  let code = '';
  for (let i = 0; i < 12; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];
  const now = Date.now();
  const invites = readInvites(dataFile)
    .filter((invite) => invite.expires > now && invite.person.toLowerCase() !== person.toLowerCase());
  invites.push({ person, codeHash: hashCode(code), expires: now + INVITE_DAYS * 24 * 60 * 60 * 1000 });
  writeInvites(dataFile, invites);
  return { code: code.match(/.{4}/g).join('-'), days: INVITE_DAYS };
}

function findInvite(dataFile, code) {
  const codeHash = hashCode(code);
  return readInvites(dataFile).find((invite) => invite.codeHash === codeHash && invite.expires > Date.now()) || null;
}

function useInvite(dataFile, invite) {
  writeInvites(dataFile, readInvites(dataFile).filter((other) => other.codeHash !== invite.codeHash));
}

module.exports = { createInvite, findInvite, useInvite };
