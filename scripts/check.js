// Audits the real app read-only, then exercises persistence on a throwaway copy of its data.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

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

function start(file, port, extra = {}) {
  const child = spawn('node', ['server.js'], { cwd: APP, env: { ...process.env, ADMIN_TOKEN: '', TRUST_PROXY: '', DATA_FILE: file, PORT: port, ...extra }, stdio: 'pipe' });
  child.stderrText = '';
  child.stderr.on('data', (d) => { child.stderrText += d; });
  return child;
}
async function waitUp(base) {
  for (let i = 0; i < 30; i += 1) {
    try { return await fetch(`${base}/api/state`); } catch { await sleep(150); }
  }
  throw new Error('server did not start');
}

// A browser stand-in that keeps its session cookie.
function client(base) {
  let cookie = '';
  const request = async (url, options = {}) => {
    const res = await fetch(base + url, { ...options, headers: { ...options.headers, ...(cookie ? { cookie } : {}) } });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
  const J = { 'Content-Type': 'application/json' };
  const send = (url, body, method = 'POST') => request(url, { method, headers: J, body: JSON.stringify(body) });
  return {
    request,
    send,
    state: async () => (await request('/api/state')).json(),
    cookie: () => cookie,
    remove: (url) => request(url, { method: 'DELETE' }),
  };
}

function invite(file, name) {
  const output = execFileSync('node', ['scripts/invite.js', name], { cwd: APP, env: { ...process.env, DATA_FILE: file }, encoding: 'utf8' });
  return output.match(/Code: (\S+)/)[1];
}

async function join(base, file, name) {
  const person = client(base);
  const password = randomBytes(12).toString('hex');
  const res = await person.send('/api/claim', { code: invite(file, name), password });
  if (res.status !== 200) throw new Error(`could not join as ${name}: ${res.status}`);
  person.password = password;
  return person;
}

const stop = (child) => new Promise((r) => { child.once('exit', r); child.kill('SIGKILL'); });

// Read-only. Skips whatever isn't there, such as on a fresh copy with no ratings yet.
async function auditRealApp() {
  console.log('--- Real app (read-only) ---');
  if (!fs.existsSync(REAL)) {
    console.log('No saved ratings yet, so there is nothing to audit.');
    return;
  }
  let response = null;
  try {
    response = await fetch('http://localhost:4173/api/state');
  } catch {
    console.log('The app is not running, so checking the saved file only.');
  }
  const raw = fs.readFileSync(REAL, 'utf8');
  const disk = JSON.parse(raw);
  ok('saved file is valid JSON', true, `${raw.length} bytes`);
  ok('no half-written temp file left behind', !fs.existsSync(`${REAL}.tmp`));
  audit({ ...disk, people: disk.people || [] }, path.join(APP, 'data', 'photos'), 'real data');
  if (!response) return;
  ok('running app requires sign-in', response.status === 401, `status ${response.status}`);
  ok('running app reveals nothing when signed out', !('ratings' in await response.json()));
  for (const page of ['/', '/app.js', '/styles.css']) {
    ok(`serves ${page}`, (await fetch(`http://localhost:4173${page}`)).status === 200);
  }
}

(async () => {
  const strip = (d) => JSON.stringify({ restaurants: d.restaurants, ratings: d.ratings });
  await auditRealApp();

  console.log('--- Copy: saving through restarts ---');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burger-verify-'));
  const file = path.join(dir, 'ratings.json');
  const seed = () => {
    const real = fs.existsSync(REAL) ? JSON.parse(fs.readFileSync(REAL, 'utf8')) : { restaurants: [], ratings: [], people: ['Matt', 'Sam'] };
    delete real.accounts;
    delete real.sessions;
    fs.writeFileSync(file, JSON.stringify(real));
  };
  seed();
  const base = 'http://localhost:4175';
  let server = start(file, 4175);
  await waitUp(base);
  let matt = await join(base, file, 'matt');
  const sam = await join(base, file, 'Sam');
  const before = await matt.state();
  const post = (url, body) => matt.send(url, body);
  const upload = async () => (await (await matt.request('/api/photos', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg })).json()).id;

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const photo = await upload();
  await post('/api/ratings', { restaurant: { name: 'Verify Grill', area: 'Testville, MA' }, dish: 'burger', score: 7.3, note: 'first', photo });
  await sam.send('/api/wishes', { restaurant: { placeId: 'osm:N999', name: 'Verify Wish', area: 'Testville, MA', address: '1 Main', lat: 42, lon: -71 }, note: 'try it' });
  await stop(server); // Hard kill: nothing gets a chance to flush on the way out.
  server = start(file, 4175);
  await waitUp(base);
  let s = await matt.state();
  ok('sign-ins survive a restart', Array.isArray(s.ratings));
  const rating = s.ratings.find((r) => r.note === 'first');
  ok('rating survives a hard kill', rating && rating.score === 7.3 && rating.rater === 'Matt');
  ok('photo survives and is served', rating && (await matt.request(`/photos/${rating.photo}.jpg`)).status === 200);
  ok('want-to-try survives', s.wishes.some((w) => w.note === 'try it'));
  ok('existing ratings untouched', before.ratings.every((b) => JSON.stringify(s.ratings.find((r) => r.id === b.id)) === JSON.stringify(b)));

  // Update, replacing the photo; the old file should go.
  const photo2 = await upload();
  await post('/api/ratings', { restaurant: { id: rating.restaurantId }, dish: 'burger', score: 8.1, note: 'second', photo: photo2 });
  await sleep(200);
  ok('replacing a photo removes the old file', !fs.existsSync(path.join(dir, 'photos', `${photo}.jpg`)) && fs.existsSync(path.join(dir, 'photos', `${photo2}.jpg`)));
  await post('/api/ratings', { restaurant: { id: rating.restaurantId }, dish: 'burger', score: 8.2, note: 'third' });
  s = await matt.state();
  ok('editing without a photo keeps it', s.ratings.find((r) => r.id === rating.id).photo === photo2);

  await matt.remove(`/api/ratings/${rating.id}`);
  await sleep(200);
  const wish = s.wishes.find((w) => w.note === 'try it');
  await sam.remove(`/api/wishes/${wish.id}`);
  await stop(server);
  server = start(file, 4175);
  await waitUp(base);
  s = await matt.state();
  ok('deletes survive a restart', !s.ratings.some((r) => r.id === rating.id) && !s.wishes.length);
  ok('deleting a rating removes its photo', !fs.existsSync(path.join(dir, 'photos', `${photo2}.jpg`)));
  ok('emptied restaurants are cleaned up', !s.restaurants.some((r) => r.name.startsWith('Verify')));
  ok('back to the original ratings', strip(s) === strip(before));

  // Many people posting at once.
  const rids = await Promise.all(Array.from({ length: 25 }, (_, i) => post('/api/ratings', { restaurant: { name: `Busy ${i}`, area: 'X' }, dish: 'caesar', score: 5 })));
  ok('25 simultaneous posts succeed', rids.every((r) => r.status === 200), rids.map((r) => r.status).filter((c) => c !== 200).join());
  await stop(server);
  const afterBurst = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok('all 25 are on disk', afterBurst.ratings.filter((r) => r.dish === 'caesar' && r.score === 5 && r.rater === 'Matt').length === 25);
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
  matt = await join(base, file, 'Matt');
  const keptPhoto = await upload();
  await post('/api/ratings', { restaurant: { name: 'Photo Place', area: '' }, dish: 'burger', score: 6, note: 'keep', photo: keptPhoto });
  const seeded = (await matt.state()).ratings.find((r) => r.note === 'keep');
  const newPhoto = await upload();
  fs.mkdirSync(`${file}.tmp`); // Makes the next write fail, like a locked file would.
  const failed = await post('/api/ratings', { restaurant: { name: 'Should Not Stick', area: '' }, dish: 'burger', score: 6 });
  ok('failed save reports an error', failed.status === 500, `status ${failed.status}`);
  let memory = await matt.state();
  ok('failed save does not show as saved', !memory.restaurants.some((r) => r.name === 'Should Not Stick'));
  const failedReplace = await post('/api/ratings', { restaurant: { id: seeded.restaurantId }, dish: 'burger', score: 2, note: 'bad', photo: newPhoto });
  await sleep(200);
  memory = await matt.state();
  const stillThere = memory.ratings.find((r) => r.id === seeded.id);
  ok('failed edit keeps the old grade and photo', failedReplace.status === 500 && stillThere.score === 6 && stillThere.photo === keptPhoto && fs.existsSync(path.join(dir, 'photos', `${keptPhoto}.jpg`)));
  const failedDelete = await matt.remove(`/api/ratings/${seeded.id}`);
  await sleep(200);
  memory = await matt.state();
  ok('failed delete keeps the rating and photo', failedDelete.status === 500 && memory.ratings.some((r) => r.id === seeded.id) && fs.existsSync(path.join(dir, 'photos', `${keptPhoto}.jpg`)));
  fs.rmdirSync(`${file}.tmp`);
  const retried = await post('/api/ratings', { restaurant: { name: 'Should Stick', area: '' }, dish: 'burger', score: 6 });
  ok('saving works again once the file is free (1)', retried.status === 200);
  await stop(server);
  ok('saving works again once the file is free', retried.status === 200 && JSON.parse(fs.readFileSync(file, 'utf8')).restaurants.some((r) => r.name === 'Should Stick') && !JSON.parse(fs.readFileSync(file, 'utf8')).restaurants.some((r) => r.name === 'Should Not Stick'));

  console.log('--- Copy: accounts ---');
  seed();
  server = start(file, 4175);
  await waitUp(base);
  const stranger = client(base);
  ok('signed-out visitors get no data', (await stranger.request('/api/state')).status === 401);
  ok('signed-out visitors cannot post', (await stranger.send('/api/ratings', { restaurant: { name: 'Nope' }, dish: 'burger', score: 5 })).status === 401);
  ok('signed-out visitors cannot search', (await stranger.request('/api/places?q=burger')).status === 401);

  const inviteCode = invite(file, 'Matt');
  ok('invite codes are not stored in the clear', !fs.readFileSync(path.join(dir, 'invites.json'), 'utf8').includes(inviteCode.replace(/-/g, '')));
  const newcomer = client(base);
  const password = randomBytes(12).toString('hex');
  ok('short passwords are refused', (await newcomer.send('/api/claim', { code: inviteCode, password: 'short' })).status === 400);
  const claimed = await newcomer.send('/api/claim', { code: inviteCode, password });
  ok('an invite claims the name, even after a short password', claimed.status === 200);
  ok('session cookie is hidden from page scripts', /HttpOnly/.test(claimed.headers.get('set-cookie')) && /SameSite=Lax/.test(claimed.headers.get('set-cookie')));
  ok('an invite only works once', (await client(base).send('/api/claim', { code: inviteCode, password })).status === 400);
  const mine = await newcomer.state();
  ok('the account is matched to the existing name', mine.me === 'Matt');
  ok('existing ratings stay with their person', mine.ratings.filter((r) => r.rater === 'Matt').length === JSON.parse(fs.readFileSync(file, 'utf8')).ratings.filter((r) => r.rater === 'Matt').length);
  ok('password hashes never reach the page', !('accounts' in mine) && !('sessions' in mine));
  const disk = fs.readFileSync(file, 'utf8');
  ok('passwords and session tokens are not stored in the clear', !disk.includes(password) && !disk.includes(newcomer.cookie().split('=')[1]));

  const raceCode = invite(file, 'Racer');
  const racers = await Promise.all([
    client(base).send('/api/claim', { code: raceCode, password: randomBytes(12).toString('hex') }),
    client(base).send('/api/claim', { code: raceCode, password: randomBytes(12).toString('hex') }),
  ]);
  ok('one invite claimed twice at once only works once', racers.map((r) => r.status).sort().join() === '200,400', racers.map((r) => r.status).join());

  const friend = await join(base, file, 'Sam');
  await friend.send('/api/ratings', { restaurant: { name: 'Auth Grill', area: '' }, dish: 'burger', rater: 'Matt', person: 'Matt', score: 4, note: 'spoof' });
  const after = await friend.state();
  const spoof = after.ratings.find((r) => r.note === 'spoof');
  ok('a typed name is ignored: you can only post as yourself', spoof.rater === 'Sam');
  ok("you cannot delete someone else's rating", (await newcomer.remove(`/api/ratings/${spoof.id}`)).status === 403);
  await friend.send('/api/wishes', { restaurant: { name: 'Auth Grill', area: '' }, note: 'mine' });
  const wishId = (await friend.state()).wishes.find((w) => w.note === 'mine').id;
  ok("you cannot change someone else's list", (await newcomer.remove(`/api/wishes/${wishId}`)).status === 403);

  const signIn = client(base);
  ok('the right password signs in', (await signIn.send('/api/login', { name: 'matt', password })).status === 200);
  await signIn.send('/api/logout', {});
  ok('signing out ends the session', (await signIn.request('/api/state')).status === 401);
  const guesser = client(base);
  for (let i = 0; i < 5; i += 1) await guesser.send('/api/login', { name: 'Sam', password: 'wrong-password' });
  ok('repeated wrong passwords lock the name', (await guesser.send('/api/login', { name: 'Sam', password: friend.password })).status === 429);

  const reset = client(base);
  await reset.send('/api/claim', { code: invite(file, 'Matt'), password: randomBytes(12).toString('hex') });
  ok('a password reset signs out old sessions', (await newcomer.request('/api/state')).status === 401);

  console.log('--- Copy: freeze and backup ---');
  const script = (name, ...args) => execFileSync('node', [`scripts/${name}.js`, ...args], { cwd: APP, env: { ...process.env, DATA_FILE: file }, encoding: 'utf8' });
  script('freeze', 'Moved to the new link');
  const frozenPost = await friend.send('/api/ratings', { restaurant: { name: 'Frozen Grill', area: '' }, dish: 'burger', score: 5 });
  const frozenState = await friend.state();
  ok('freezing blocks changes right away', frozenPost.status === 503 && !frozenState.restaurants.some((r) => r.name === 'Frozen Grill'));
  ok('frozen data can still be read, with the message', frozenState.frozen === 'Moved to the new link' && Array.isArray(frozenState.ratings));
  const frozenFile = fs.readFileSync(file, 'utf8');
  const frozenVisitor = client(base);
  ok('frozen sign-in still works', (await frozenVisitor.send('/api/login', { name: 'Sam', password: friend.password })).status !== 503);
  await frozenVisitor.send('/api/logout', {});
  const frozenPlace = frozenState.restaurants[0];
  if (frozenPlace) await friend.request(`/api/restaurants/${frozenPlace.id}/website`);
  ok('frozen claims are refused', (await client(base).send('/api/claim', { code: invite(file, 'Late'), password: randomBytes(12).toString('hex') })).status === 503);
  ok('nothing changes the file while frozen', fs.readFileSync(file, 'utf8') === frozenFile);
  script('freeze', 'off');
  ok('unfreezing allows changes again', (await friend.send('/api/ratings', { restaurant: { name: 'Thawed Grill', area: '' }, dish: 'burger', score: 5 })).status === 200);
  const made = script('backup').replace('Backed up to ', '').trim();
  ok('a backup is an exact copy', fs.readFileSync(path.join(made, 'ratings.json'), 'utf8') === fs.readFileSync(file, 'utf8'));
  ok('an automatic backup was made on startup', fs.readdirSync(path.join(dir, 'backups')).some((name) => name.startsWith('auto_')));
  await stop(server);

  console.log('--- Copy: moving to a host ---');
  seed();
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burger-host-'));
  const hostFile = path.join(hostDir, 'ratings.json');
  const hostBase = 'http://localhost:4177';
  const token = randomBytes(32).toString('hex');
  server = start(file, 4175);
  await waitUp(base);
  ok('admin tools do not exist without a token', (await fetch(`${base}/api/admin/export`)).status === 404);
  await stop(server);
  const homeFile = JSON.parse(fs.readFileSync(file, 'utf8'));
  homeFile.accounts = [{ person: 'Matt', password: 'not-a-real-hash:00' }];
  homeFile.sessions = [{ tokenHash: 'old', person: 'Matt', expires: Date.now() + 100000 }];
  fs.writeFileSync(file, JSON.stringify(homeFile));
  fs.mkdirSync(path.join(dir, 'photos'), { recursive: true });
  const movedPhoto = '00000000-0000-4000-8000-000000000001';
  fs.writeFileSync(path.join(dir, 'photos', `${movedPhoto}.jpg`), jpeg);
  const host = start(hostFile, 4177, { ADMIN_TOKEN: token, TRUST_PROXY: '1', AUTO_BACKUP_PHOTOS: '0' });
  await waitUp(hostBase);
  const hostScript = (args, tokenValue = token) => execFileSync('node', ['scripts/host.js', ...args], {
    cwd: APP,
    env: { ...process.env, DATA_FILE: file, HOST_URL: hostBase, ADMIN_TOKEN: tokenValue },
    encoding: 'utf8',
    stdio: 'pipe',
  });
  ok('wrong admin token is refused', (await fetch(`${hostBase}/api/admin/export`, { headers: { Authorization: 'Bearer wrong' } })).status === 401);
  ok('upload is verified', /Uploaded and verified/.test(hostScript(['push'])));
  const exported = await (await fetch(`${hostBase}/api/admin/export`, { headers: { Authorization: `Bearer ${token}` } })).json();
  ok('everything arrives, including accounts and photos', JSON.stringify(exported.data.ratings) === JSON.stringify(homeFile.ratings) && exported.data.accounts.length === 1 && exported.photoIds.includes(movedPhoto));
  ok('old sign-ins do not move', !('sessions' in exported.data) && JSON.parse(fs.readFileSync(hostFile, 'utf8')).sessions.length === 0);
  let refused = false;
  try { hostScript(['push']); } catch (err) { refused = /already has data/.test(err.stderr); }
  ok('a second upload can never overwrite the host', refused);
  ok('invites can be made remotely', /Code: /.test(hostScript(['invite', 'Sam'])));
  const hostInvite = hostScript(['invite', 'Remote Pal']).match(/Code: (\S+)/)[1];
  const hostPerson = client(hostBase);
  const claimedHost = await hostPerson.send('/api/claim', { code: hostInvite, password: randomBytes(12).toString('hex') });
  ok('a remote invite works', claimedHost.status === 200 && (await hostPerson.state()).me === 'Remote Pal');
  const forwarded = async (ip, code) => fetch(`${hostBase}/api/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify({ code, password: randomBytes(12).toString('hex') }) });
  for (let i = 0; i < 5; i += 1) await forwarded('203.0.113.1', 'BAD-CODE');
  ok('wrong codes lock out only that visitor', (await forwarded('203.0.113.1', 'BAD-CODE')).status === 429 && (await forwarded('203.0.113.2', 'BAD-CODE')).status === 400);
  ok('a visitor cannot dodge the lock with a fake address', (await forwarded('198.51.100.9, 203.0.113.1', 'BAD-CODE')).status === 429);
  const httpsLogin = await fetch(`${hostBase}/api/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.3' }, body: JSON.stringify({ code: hostScript(['invite', 'Secure Pal']).match(/Code: (\S+)/)[1], password: randomBytes(12).toString('hex') }) });
  ok('on https, the sign-in cookie is https-only', /; Secure/.test(httpsLogin.headers.get('set-cookie')));
  ok('on https, browsers are told to stay on https', Boolean(httpsLogin.headers.get('strict-transport-security')));
  const pulled = hostScript(['pull']).match(/to (.+)$/m)[1].trim();
  ok('off-site backup matches the host', JSON.stringify(JSON.parse(fs.readFileSync(path.join(pulled, 'ratings.json'), 'utf8')).ratings) === JSON.stringify(JSON.parse(fs.readFileSync(hostFile, 'utf8')).ratings) && fs.existsSync(path.join(pulled, 'photos', `${movedPhoto}.jpg`)));
  await stop(host);
  const hostAgain = start(hostFile, 4177, { ADMIN_TOKEN: token, TRUST_PROXY: '1', AUTO_BACKUP_PHOTOS: '0' });
  await waitUp(hostBase);
  ok('data on the host survives a restart', JSON.parse(fs.readFileSync(hostFile, 'utf8')).ratings.length === homeFile.ratings.length && fs.existsSync(path.join(hostDir, 'photos', `${movedPhoto}.jpg`)));
  const hostBackups = fs.readdirSync(path.join(hostDir, 'backups'));
  ok('automatic backups on the host skip photos', hostBackups.length > 0 && hostBackups.every((name) => !fs.existsSync(path.join(hostDir, 'backups', name, 'photos'))));
  let httpRefused = false;
  try {
    execFileSync('node', ['scripts/host.js', 'pull'], { cwd: APP, env: { ...process.env, DATA_FILE: file, HOST_URL: 'http://example.com', ADMIN_TOKEN: token }, stdio: 'pipe' });
  } catch (err) { httpRefused = /must start with https/.test(String(err.stderr)); }
  ok('owner tools refuse an unencrypted link', httpRefused);
  const page = await fetch(hostBase);
  ok('browser security rules are on', /frame-ancestors 'none'/.test(page.headers.get('content-security-policy')));
  for (const asset of ['/manifest.webmanifest', '/sw.js', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png']) {
    ok(`serves ${asset}`, (await fetch(hostBase + asset)).status === 200);
  }
  await stop(hostAgain);
  fs.rmSync(hostDir, { recursive: true, force: true });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exitCode = failures ? 1 : 0;
})().catch((err) => { console.error(err); process.exit(1); });
