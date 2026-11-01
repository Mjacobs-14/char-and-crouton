// Audits the real app read-only, then exercises persistence on a throwaway copy of its data.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const APP = path.join(__dirname, '..');
const REAL = path.join(APP, 'data', 'ratings.json');
let failures = 0;
const ok = (label, pass, extra = '') => {
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function audit(db, photoDir, label) {
  const ids = new Set(db.restaurants.map((r) => r.id));
  ok(`${label}: every rating points at a restaurant`, db.ratings.every((r) => ids.has(r.restaurantId)));
  ok(`${label}: every want-to-try points at a restaurant`, db.wishes === undefined || db.wishes.every((w) => ids.has(w.restaurantId)));
  ok(`${label}: scores are 1.0-10.0 in tenths`, db.ratings.every((r) => r.score >= 1 && r.score <= 10 && Math.abs(r.score * 10 - Math.round(r.score * 10)) < 1e-9));
  const keys = db.ratings.map((r) => `${r.restaurantId}|${r.dish}|${r.rater.toLowerCase()}`);
  ok(`${label}: one rating per person, dish and restaurant`, new Set(keys).size === keys.length);
  const unused = db.restaurants.filter((r) => !db.ratings.some((x) => x.restaurantId === r.id) && !(db.wishes || []).some((w) => w.restaurantId === r.id));
  ok(`${label}: no restaurants left unused`, unused.length === 0, unused.map((r) => r.name).join(', '));
  ok(`${label}: raters are all in the people list`, db.ratings.every((r) => db.people.includes(r.rater)));
  const photos = db.ratings.filter((r) => r.photo).map((r) => r.photo);
  ok(`${label}: every photo's file exists`, photos.every((p) => fs.existsSync(path.join(photoDir, `${p}.jpg`))), `${photos.length} photos`);
  const files = fs.existsSync(photoDir) ? fs.readdirSync(photoDir) : [];
  const orphans = files.filter((f) => !photos.includes(f.replace(/\.jpg$/, '')));
  ok(`${label}: no orphaned photo files`, orphans.length === 0, `${files.length} files, ${orphans.length} orphans`);
}

function start(file, port) {
  const child = spawn('node', ['server.js'], { cwd: APP, env: { ...process.env, DATA_FILE: file, PORT: port }, stdio: 'pipe' });
  child.stderrText = '';
  child.stderr.on('data', (d) => { child.stderrText += d; });
  return child;
}
async function waitUp(base) {
  for (let i = 0; i < 30; i += 1) {
    try { return await (await fetch(`${base}/api/state`)).json(); } catch { await sleep(150); }
  }
  throw new Error('server did not start');
}
const stop = (child) => new Promise((r) => { child.once('exit', r); child.kill('SIGKILL'); });

// Read-only. Skips whatever isn't there, such as on a fresh copy with no ratings yet.
async function auditRealApp(strip) {
  console.log('--- Real app (read-only) ---');
  if (!fs.existsSync(REAL)) {
    console.log('No saved ratings yet, so there is nothing to audit.');
    return;
  }
  let live;
  try {
    live = await (await fetch('http://localhost:4173/api/state')).json();
  } catch {
    console.log('The app is not running, so checking the saved file only.');
  }
  const raw = fs.readFileSync(REAL, 'utf8');
  const disk = JSON.parse(raw);
  ok('saved file is valid JSON', true, `${raw.length} bytes`);
  ok('no half-written temp file left behind', !fs.existsSync(`${REAL}.tmp`));
  audit({ ...disk, people: disk.people || (live ? live.people : []) }, path.join(APP, 'data', 'photos'), 'real data');
  if (!live) return;
  ok('running app is reachable', true, `${live.ratings.length} ratings, ${live.restaurants.length} restaurants, ${live.wishes.length} saved places`);
  ok('running app matches the saved file', strip(live) === strip(disk));
  for (const page of ['/', '/app.js', '/styles.css']) {
    ok(`serves ${page}`, (await fetch(`http://localhost:4173${page}`)).status === 200);
  }
}

(async () => {
  const strip = (d) => JSON.stringify({ restaurants: d.restaurants, ratings: d.ratings });
  await auditRealApp(strip);

  console.log('--- Copy: saving through restarts ---');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burger-verify-'));
  const file = path.join(dir, 'ratings.json');
  const seed = () => {
    if (fs.existsSync(REAL)) fs.copyFileSync(REAL, file);
    else fs.writeFileSync(file, JSON.stringify({ restaurants: [], ratings: [] }));
  };
  seed();
  const base = 'http://localhost:4175';
  const J = { 'Content-Type': 'application/json' };
  let server = start(file, 4175);
  const before = await waitUp(base);
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: J, body: JSON.stringify(body) });

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const { id: photo } = await (await fetch(`${base}/api/photos`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg })).json();
  await post('/api/ratings', { restaurant: { name: 'Verify Grill', area: 'Testville, MA' }, dish: 'burger', rater: 'matt', score: 7.3, note: 'first', photo });
  await post('/api/wishes', { restaurant: { placeId: 'osm:N999', name: 'Verify Wish', area: 'Testville, MA', address: '1 Main', lat: 42, lon: -71 }, person: 'Sam', note: 'try it' });
  await stop(server); // Hard kill: nothing gets a chance to flush on the way out.
  server = start(file, 4175);
  let s = await waitUp(base);
  const rating = s.ratings.find((r) => r.note === 'first');
  ok('rating survives a hard kill', rating && rating.score === 7.3 && rating.rater === 'Matt');
  ok('photo survives and is served', rating && (await fetch(`${base}/photos/${rating.photo}.jpg`)).status === 200);
  ok('want-to-try survives', s.wishes.some((w) => w.note === 'try it'));
  ok('existing ratings untouched', before.ratings.every((b) => JSON.stringify(s.ratings.find((r) => r.id === b.id)) === JSON.stringify(b)));

  // Update, replacing the photo; the old file should go.
  const { id: photo2 } = await (await fetch(`${base}/api/photos`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg })).json();
  await post('/api/ratings', { restaurant: { id: rating.restaurantId }, dish: 'burger', rater: 'Matt', score: 8.1, note: 'second', photo: photo2 });
  await sleep(200);
  ok('replacing a photo removes the old file', !fs.existsSync(path.join(dir, 'photos', `${photo}.jpg`)) && fs.existsSync(path.join(dir, 'photos', `${photo2}.jpg`)));
  await post('/api/ratings', { restaurant: { id: rating.restaurantId }, dish: 'burger', rater: 'Matt', score: 8.2, note: 'third' });
  s = await (await fetch(`${base}/api/state`)).json();
  ok('editing without a photo keeps it', s.ratings.find((r) => r.id === rating.id).photo === photo2);

  await fetch(`${base}/api/ratings/${rating.id}`, { method: 'DELETE' });
  await sleep(200);
  const wish = s.wishes.find((w) => w.note === 'try it');
  await fetch(`${base}/api/wishes/${wish.id}`, { method: 'DELETE' });
  await stop(server);
  server = start(file, 4175);
  s = await waitUp(base);
  ok('deletes survive a restart', !s.ratings.some((r) => r.id === rating.id) && !s.wishes.length);
  ok('deleting a rating removes its photo', !fs.existsSync(path.join(dir, 'photos', `${photo2}.jpg`)));
  ok('emptied restaurants are cleaned up', !s.restaurants.some((r) => r.name.startsWith('Verify')));
  ok('back to the original ratings', strip(s) === strip(before));

  // Many people posting at once.
  const rids = await Promise.all(Array.from({ length: 25 }, (_, i) => post('/api/ratings', { restaurant: { name: `Busy ${i}`, area: 'X' }, dish: 'caesar', rater: `Person${i}`, score: 5 })));
  ok('25 simultaneous posts succeed', rids.every((r) => r.status === 200), rids.map((r) => r.status).filter((c) => c !== 200).join());
  await stop(server);
  const afterBurst = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok('all 25 are on disk', afterBurst.ratings.filter((r) => r.dish === 'caesar' && r.rater.startsWith('Person')).length === 25);
  audit(afterBurst, path.join(dir, 'photos'), 'copy after tests');

  // A damaged file must never be replaced by an empty one.
  fs.writeFileSync(file, '{"restaurants": [');
  server = start(file, 4175);
  const code = await new Promise((r) => { server.once('exit', r); setTimeout(() => r('still running'), 2500); });
  ok('refuses to start on a damaged file', code === 1, `exit ${code}`);
  ok('damaged file is left alone', fs.readFileSync(file, 'utf8') === '{"restaurants": [');
  if (code === 'still running') await stop(server);

  // A failed save should be reported and not look like success.
  seed();
  server = start(file, 4175);
  await waitUp(base);
  const upload = async () => (await (await fetch(`${base}/api/photos`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg })).json()).id;
  const keptPhoto = await upload();
  await post('/api/ratings', { restaurant: { name: 'Photo Place', area: '' }, dish: 'burger', rater: 'Matt', score: 6, note: 'keep', photo: keptPhoto });
  const seeded = (await (await fetch(`${base}/api/state`)).json()).ratings.find((r) => r.note === 'keep');
  const newPhoto = await upload();
  fs.mkdirSync(`${file}.tmp`); // Makes the next write fail, like a locked file would.
  const failed = await post('/api/ratings', { restaurant: { name: 'Should Not Stick', area: '' }, dish: 'burger', rater: 'Matt', score: 6 });
  ok('failed save reports an error', failed.status === 500, `status ${failed.status}`);
  let memory = await (await fetch(`${base}/api/state`)).json();
  ok('failed save does not show as saved', !memory.restaurants.some((r) => r.name === 'Should Not Stick'));
  const failedReplace = await post('/api/ratings', { restaurant: { id: seeded.restaurantId }, dish: 'burger', rater: 'Matt', score: 2, note: 'bad', photo: newPhoto });
  await sleep(200);
  memory = await (await fetch(`${base}/api/state`)).json();
  const stillThere = memory.ratings.find((r) => r.id === seeded.id);
  ok('failed edit keeps the old grade and photo', failedReplace.status === 500 && stillThere.score === 6 && stillThere.photo === keptPhoto && fs.existsSync(path.join(dir, 'photos', `${keptPhoto}.jpg`)));
  const failedDelete = await fetch(`${base}/api/ratings/${seeded.id}`, { method: 'DELETE' });
  await sleep(200);
  memory = await (await fetch(`${base}/api/state`)).json();
  ok('failed delete keeps the rating and photo', failedDelete.status === 500 && memory.ratings.some((r) => r.id === seeded.id) && fs.existsSync(path.join(dir, 'photos', `${keptPhoto}.jpg`)));
  fs.rmdirSync(`${file}.tmp`);
  const retried = await post('/api/ratings', { restaurant: { name: 'Should Stick', area: '' }, dish: 'burger', rater: 'Matt', score: 6 });
  await stop(server);
  ok('saving works again once the file is free', retried.status === 200 && JSON.parse(fs.readFileSync(file, 'utf8')).restaurants.some((r) => r.name === 'Should Stick') && !JSON.parse(fs.readFileSync(file, 'utf8')).restaurants.some((r) => r.name === 'Should Not Stick'));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exitCode = failures ? 1 : 0;
})().catch((err) => { console.error(err); process.exit(1); });
