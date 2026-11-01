// Makes a named backup you keep until you delete it, such as before moving the app.
const path = require('node:path');
const { backup } = require('../lib/backup');

const dataFile = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'ratings.json');
const made = backup(dataFile, 'manual');
console.log(made ? `Backed up to ${made}` : 'There are no ratings to back up yet.');
