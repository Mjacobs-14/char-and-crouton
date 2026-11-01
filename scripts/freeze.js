// Stops all changes while the app moves, so there's only ever one live copy.
// Takes effect immediately, with no restart. Everything can still be read.
const fs = require('node:fs');
const path = require('node:path');

const dataFile = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'ratings.json');
const frozenFile = path.join(path.dirname(dataFile), 'FROZEN');
const message = process.argv.slice(2).join(' ').trim();

if (message === 'off') {
  fs.rmSync(frozenFile, { force: true });
  console.log('Unfrozen. Ratings can be posted again.');
} else {
  fs.mkdirSync(path.dirname(frozenFile), { recursive: true });
  fs.writeFileSync(frozenFile, message || 'The app is moving. Ratings are paused for now.');
  console.log('Frozen. Nobody can post or change anything until you run: npm run freeze -- off');
}
