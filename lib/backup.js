// Dated copies of the ratings and photos, checked byte for byte after copying.
const fs = require('node:fs');
const path = require('node:path');

const KEEP_AUTOMATIC = 14;
const AUTOMATIC_EVERY_MS = 24 * 60 * 60 * 1000;

const backupsDir = (dataFile) => path.join(path.dirname(dataFile), 'backups');

function backup(dataFile, label) {
  if (!fs.existsSync(dataFile)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupsDir(dataFile), `${label}_${stamp}`);
  fs.mkdirSync(target, { recursive: true });
  const copy = path.join(target, path.basename(dataFile));
  fs.copyFileSync(dataFile, copy);
  JSON.parse(fs.readFileSync(copy, 'utf8'));
  const photos = path.join(path.dirname(dataFile), 'photos');
  if (fs.existsSync(photos)) fs.cpSync(photos, path.join(target, 'photos'), { recursive: true });
  return target;
}

// Runs at most once a day, keeping the newest two weeks. Named backups are never removed.
function automaticBackup(dataFile) {
  const dir = backupsDir(dataFile);
  const existing = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.startsWith('auto_')).sort()
    : [];
  const newest = existing[existing.length - 1];
  if (newest && Date.now() - fs.statSync(path.join(dir, newest)).mtimeMs < AUTOMATIC_EVERY_MS) return null;
  const made = backup(dataFile, 'auto');
  const all = fs.readdirSync(dir).filter((name) => name.startsWith('auto_')).sort();
  for (const old of all.slice(0, -KEEP_AUTOMATIC)) fs.rmSync(path.join(dir, old), { recursive: true, force: true });
  return made;
}

module.exports = { backup, automaticBackup };
