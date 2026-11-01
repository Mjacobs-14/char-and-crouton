// Makes a one-time invite code. Use it to add someone, or to reset a forgotten password.
const fs = require('node:fs');
const path = require('node:path');
const { createInvite } = require('../lib/invites');

const dataFile = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'ratings.json');
const typed = process.argv.slice(2).join(' ').trim().replace(/\s+/g, ' ');
if (!typed || typed.length > 30) {
  console.error('Usage: npm run invite -- Name');
  process.exit(1);
}

let db = { people: [], accounts: [] };
if (fs.existsSync(dataFile)) db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const known = (db.people || []).find((person) => person.toLowerCase() === typed.toLowerCase());
const person = known || typed;
const hasAccount = (db.accounts || []).some((account) => account.person === person);

const { code, days } = createInvite(dataFile, person);
console.log(`\n${hasAccount ? 'Password reset' : 'Invite'} for ${person}${known ? '' : ' (new person)'}`);
console.log(`Code: ${code}`);
console.log(`Works once, for ${days} days. Send it privately.\n`);
