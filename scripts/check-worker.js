// Runs the Cloudflare version on this computer with Cloudflare's own local engine and a throwaway
// database, then tests sign-in, ratings, photos, the move and backups. Never touches real data.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const APP = path.join(__dirname, '..');
const WRANGLER = path.join(APP, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const REAL = path.join(APP, 'data', 'ratings.json');
const PORT = 8788;
const base = `http://localhost:${PORT}`;
let failures = 0;
const ok = (label, pass, extra = '') => {
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'burger-worker-'));
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burger-home-'));
const homeFile = path.join(homeDir, 'ratings.json');
const token = randomBytes(32).toString('hex');
const wrangler = (args) => execFileSync('node', [WRANGLER, ...args], { cwd: APP, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, CI: '1' } });

function start() {
  const child = spawn('node', [WRANGLER, 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', state, '--var', `ADMIN_TOKEN:${token}`],
    { cwd: APP, stdio: 'pipe', env: { ...process.env, CI: '1' } });
  child.output = '';
  child.stdout.on('data', (d) => { child.output += d; });
  child.stderr.on('data', (d) => { child.output += d; });
  return child;
}
const stop = (child) => new Promise((r) => {
  if (child.exitCode !== null) { r(); return; }
  child.once('exit', r);
  // wrangler starts its own helper processes, so the whole tree has to go.
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGKILL');
});
async function waitUp() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${base}/api/state`);
      if (res.status) return;
    } catch { await sleep(500); }
  }
  throw new Error('The local Cloudflare server did not start.');
}

function client() {
  let cookie = '';
  const request = async (url, options = {}) => {
    const res = await fetch(base + url, { ...options, headers: { ...options.headers, ...(cookie ? { cookie } : {}) } });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
  const send = (url, body, headers = {}) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { request, send, state: async () => (await request('/api/state')).json(), remove: (url) => request(url, { method: 'DELETE' }) };
}

const host = (args) => execFileSync('node', ['scripts/host.js', ...args], {
  cwd: APP, env: { ...process.env, DATA_FILE: homeFile, HOST_URL: base, ADMIN_TOKEN: token }, encoding: 'utf8', stdio: 'pipe',
});
const inviteCode = (name) => host(['invite', name]).match(/Code: (\S+)/)[1];
async function join(name) {
  const person = client();
  const password = randomBytes(12).toString('hex');
  const res = await person.send('/api/claim', { code: inviteCode(name), password });
  if (res.status !== 200) throw new Error(`could not join as ${name}: ${res.status} ${await res.text()}`);
  person.password = password;
  return person;
}

(async () => {
  let server;
  try {
    console.log('--- Setting up a throwaway Cloudflare database ---');
    wrangler(['d1', 'migrations', 'apply', 'char-and-crouton', '--local', '--persist-to', state]);
    wrangler(['d1', 'migrations', 'apply', 'char-and-crouton-photos', '--local', '--persist-to', state]);

    // A copy of the real data without real passwords, plus one home-style account to test the move.
    const real = fs.existsSync(REAL) ? JSON.parse(fs.readFileSync(REAL, 'utf8')) : { restaurants: [], ratings: [], people: [], wishes: [] };
    const seeded = {
      restaurants: real.restaurants, ratings: real.ratings, people: [...new Set([...(real.people || []), 'Matt'])], wishes: real.wishes || [],
      accounts: [{ person: 'Matt', password: 'aa:bb' }],
    };
    fs.writeFileSync(homeFile, JSON.stringify(seeded));
    const homePhoto = '00000000-0000-4000-8000-000000000009';
    fs.mkdirSync(path.join(homeDir, 'photos'));
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    fs.writeFileSync(path.join(homeDir, 'photos', `${homePhoto}.jpg`), jpeg);

    server = start();
    await waitUp();

    console.log('--- The page ---');
    const page = await fetch(base);
    ok('serves the app', page.status === 200 && (await page.text()).includes('Char &amp; Crouton'));
    ok('browser security rules are on', /frame-ancestors 'none'/.test(page.headers.get('content-security-policy') || ''));
    for (const asset of ['/app.js', '/auth.js', '/styles.css', '/lists.json', '/sw.js', '/manifest.webmanifest', '/icons/icon-512.png']) {
      ok(`serves ${asset}`, (await fetch(base + asset)).status === 200);
    }
    ok('code files are not served', (await fetch(`${base}/worker/index.js`)).status !== 200 && (await fetch(`${base}/wrangler.jsonc`)).status !== 200);

    console.log('--- Signed out ---');
    ok('no data without signing in', (await fetch(`${base}/api/state`)).status === 401);
    ok('no photos without signing in', (await fetch(`${base}/photos/${homePhoto}.jpg`)).status === 401);
    ok('no posting without signing in', (await client().send('/api/ratings', { restaurant: { name: 'X' }, dish: 'burger', score: 5 })).status === 401);
    ok('no exploring without signing in', (await fetch(`${base}/api/explore?lat=42.35&lon=-71.05`)).status === 401);
    ok('no city search without signing in', (await fetch(`${base}/api/areas?q=boston`)).status === 401);
    ok('wrong admin token refused', (await fetch(`${base}/api/admin/export`, { headers: { Authorization: 'Bearer wrong' } })).status === 401);

    console.log('--- Moving the data ---');
    ok('upload is verified', /Uploaded and verified/.test(host(['push'])));
    let refused = false;
    try { host(['push']); } catch (err) { refused = /already has data/.test(err.stderr); }
    ok('a second upload can never overwrite', refused);
    const legacy = await client().send('/api/login', { name: 'Matt', password: 'anything-at-all' });
    ok('old home passwords ask for a new invite', legacy.status === 400 && /new invite code/.test((await legacy.json()).error));

    console.log('--- Accounts ---');
    const matt = await join('matt');
    let s = await matt.state();
    ok('a new invite matches the existing name', s.me === 'Matt');
    ok('ratings arrive exactly as they were', JSON.stringify(s.ratings) === JSON.stringify(seeded.ratings), `${s.ratings.length} ratings`);
    ok('restaurants arrive exactly as they were', JSON.stringify(s.restaurants) === JSON.stringify(seeded.restaurants), `${s.restaurants.length} restaurants`);
    ok('passwords never reach the page', !('accounts' in s) && !('sessions' in s));
    ok('exploring without a location is refused', (await matt.request('/api/explore')).status === 400);
    const noCity = await matt.request('/api/areas?q=b');
    ok('a city search answers once signed in', noCity.status === 200 && (await noCity.json()).length === 0);
    ok('the moved photo is there', (await matt.request(`/photos/${homePhoto}.jpg`)).status === 200);
    const sam = await join('Sam');
    const signIn = client();
    const timed = Date.now();
    const loginRes = await signIn.send('/api/login', { name: 'sam', password: sam.password });
    ok('the right password signs in', loginRes.status === 200, `${Date.now() - timed} ms including the network`);
    ok('the sign-in cookie is hidden from page scripts', /HttpOnly/.test(loginRes.headers.get('set-cookie')) && /SameSite=Lax/.test(loginRes.headers.get('set-cookie')));
    await signIn.send('/api/logout', {});
    ok('signing out ends the session', (await signIn.request('/api/state')).status === 401);
    ok('forged sessions are refused', (await fetch(`${base}/api/state`, { headers: { cookie: `session=${'a'.repeat(64)}` } })).status === 401);
    const raceCode = inviteCode('Racer');
    const racers = await Promise.all([1, 2].map(() => client().send('/api/claim', { code: raceCode, password: randomBytes(12).toString('hex') })));
    ok('one invite claimed twice at once only works once', racers.map((r) => r.status).sort().join() === '200,400', racers.map((r) => r.status).join());
    const guess = (ip) => client().send('/api/login', { name: 'Sam', password: 'wrong-password' }, { 'CF-Connecting-IP': ip });
    for (let i = 0; i < 5; i += 1) await guess('203.0.113.1');
    const signInFrom = (ip) => client().send('/api/login', { name: 'Sam', password: sam.password }, { 'CF-Connecting-IP': ip });
    ok('wrong passwords lock out the guesser', (await signInFrom('203.0.113.1')).status === 429);
    ok('a guesser cannot lock the real person out', (await signInFrom('203.0.113.2')).status === 200);
    const badCode = (ip) => client().send('/api/claim', { code: 'NOPE-NOPE-NOPE', password: 'long-enough-1' }, { 'CF-Connecting-IP': ip });
    for (let i = 0; i < 5; i += 1) await badCode('203.0.113.7');
    ok('wrong invite codes lock out only that visitor', (await badCode('203.0.113.7')).status === 429 && (await badCode('203.0.113.8')).status === 400);
    const reset = client();
    await reset.send('/api/claim', { code: inviteCode('Sam'), password: randomBytes(12).toString('hex') });
    ok('a password reset signs out old sessions', (await sam.request('/api/state')).status === 401);

    console.log('--- Ratings, photos and lists ---');
    const upload = async (who) => (await (await who.request('/api/photos', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg })).json()).id;
    const photo1 = await upload(matt);
    await matt.send('/api/ratings', { restaurant: { name: 'Test Grill', area: 'Testville, MA' }, dish: 'burger', score: 7.3, note: 'first', photo: photo1, rater: 'Sam' });
    s = await matt.state();
    const mine = s.ratings.find((r) => r.note === 'first');
    ok('a rating saves under your own name, whatever the request says', mine && mine.rater === 'Matt' && mine.score === 7.3);
    ok('its photo is served', (await matt.request(`/photos/${photo1}.jpg`)).status === 200);

    // The board's small copies of photos.
    const thumb = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9]);
    const putThumb = (id, body = thumb) => matt.request(`/api/thumbs/${id}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body });
    const getThumb = async (id) => Buffer.from(await (await matt.request(`/photos/${id}.thumb.jpg`)).arrayBuffer());
    const missing = async () => (await (await matt.request('/api/thumbs/missing')).json()).ids;
    ok('without a small copy, the full photo stands in', (await getThumb(photo1)).equals(jpeg));
    ok('photos without a small copy are listed', (await missing()).includes(photo1));
    ok('a small copy saves', (await putThumb(photo1)).status === 200);
    ok('the small copy is served', (await getThumb(photo1)).equals(thumb));
    ok('a photo with a small copy is no longer listed', !(await missing()).includes(photo1));
    ok('a small copy needs its photo', (await putThumb('00000000-0000-4000-8000-00000000dead')).status === 404);
    ok('a small copy must be a JPEG', (await putThumb(photo1, 'not a photo')).status === 400);
    ok('small copies need signing in', (await fetch(`${base}/photos/${photo1}.thumb.jpg`)).status === 401);

    const photo2 = await upload(matt);
    await matt.send('/api/ratings', { restaurant: { id: mine.restaurantId }, dish: 'burger', score: 8.4, note: 'second', photo: photo2 });
    ok('replacing a photo removes the old one', (await matt.request(`/photos/${photo1}.jpg`)).status === 404);
    ok('and its small copy', (await matt.request(`/photos/${photo1}.thumb.jpg`)).status === 404);
    await matt.send('/api/ratings', { restaurant: { id: mine.restaurantId }, dish: 'burger', score: 8.5, note: 'third' });
    s = await matt.state();
    const updated = s.ratings.filter((r) => r.restaurantId === mine.restaurantId);
    ok('rating again updates instead of duplicating', updated.length === 1 && updated[0].score === 8.5 && updated[0].photo === photo2);
    for (const bad of [0.9, 10.1, 8.75, '8.5', null]) {
      ok(`score ${bad} is refused`, (await matt.send('/api/ratings', { restaurant: { id: mine.restaurantId }, dish: 'burger', score: bad })).status === 400);
    }
    ok('only burgers and Caesars', (await matt.send('/api/ratings', { restaurant: { id: mine.restaurantId }, dish: 'pizza', score: 5 })).status === 400);
    const pal = await join('Pal');
    ok("you can't delete someone else's rating", (await pal.remove(`/api/ratings/${mine.id}`)).status === 403);
    await pal.send('/api/wishes', { restaurant: { placeId: 'osm:N123', name: 'Wish Place', area: 'Testville, MA', address: '1 Main', lat: 42, lon: -71 }, note: 'try it' });
    s = await pal.state();
    const wish = s.wishes.find((w) => w.note === 'try it');
    ok('want-to-try saves with its map pin', wish && s.restaurants.some((r) => r.placeId === 'osm:N123' && r.lat === 42));
    ok("you can't change someone else's list", (await matt.remove(`/api/wishes/${wish.id}`)).status === 403);
    // Two tabs saving the same thing at the same moment must end up as one entry.
    const twice = (url, body) => Promise.all([matt.send(url, body), matt.send(url, body)]);
    const wishes = await twice('/api/wishes', { restaurant: { id: wish.restaurantId }, note: 'both tabs' });
    s = await matt.state();
    ok('the same want-to-try saved twice at once is kept once', wishes.every((r) => r.status === 200)
      && s.wishes.filter((w) => w.restaurantId === wish.restaurantId && w.person === 'Matt').length === 1, wishes.map((r) => r.status).join());
    const ratings = await twice('/api/ratings', { restaurant: { id: wish.restaurantId }, dish: 'burger', score: 6.5 });
    s = await matt.state();
    ok('the same rating saved twice at once is kept once', ratings.every((r) => r.status === 200)
      && s.ratings.filter((r) => r.restaurantId === wish.restaurantId && r.rater === 'Matt').length === 1, ratings.map((r) => r.status).join());
    await pal.send('/api/ratings', { restaurant: { id: wish.restaurantId }, dish: 'caesar', score: 9 });
    ok('rating a place takes it off your list', !(await pal.state()).wishes.some((w) => w.id === wish.id));
    const edit = await matt.request(`/api/restaurants/${mine.restaurantId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Renamed Grill', area: 'Testville, MA' }) });
    ok('restaurants can be renamed', edit.status === 200 && (await matt.state()).restaurants.some((r) => r.name === 'Renamed Grill'));
    await matt.remove(`/api/ratings/${mine.id}`);
    s = await matt.state();
    ok('deleting a rating removes it, its photo and the empty restaurant', !s.ratings.some((r) => r.id === mine.id)
      && (await matt.request(`/photos/${photo2}.jpg`)).status === 404 && !s.restaurants.some((r) => r.name === 'Renamed Grill'));
    ok('non-JPEG uploads are refused', (await matt.request('/api/photos', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: 'not a photo' })).status === 400);
    ok('oversized photos are refused', (await matt.request('/api/photos', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.concat([jpeg, Buffer.alloc(2_000_000)]) })).status === 400);
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(1_500_000)]);
    const bigId = (await (await matt.request('/api/photos', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: big })).json()).id;
    const bigBack = Buffer.from(await (await matt.request(`/photos/${bigId}.jpg`)).arrayBuffer());
    ok('a large photo comes back byte for byte', bigBack.equals(big), `${(big.length / 1e6).toFixed(1)} MB`);

    console.log('--- Freeze, restart and backup ---');
    host(['freeze', 'Moved to the new link']);
    const frozenPost = await matt.send('/api/ratings', { restaurant: { name: 'Frozen Grill', area: '' }, dish: 'burger', score: 5 });
    s = await matt.state();
    ok('freezing blocks changes', frozenPost.status === 503 && !s.restaurants.some((r) => r.name === 'Frozen Grill'));
    ok('frozen data can still be read, with the message', s.frozen === 'Moved to the new link');
    ok('new accounts wait while frozen', (await client().send('/api/claim', { code: inviteCode('Late'), password: 'long-enough-1' })).status === 503);
    host(['freeze', 'off']);
    ok('unfreezing allows changes again', (await matt.send('/api/ratings', { restaurant: { name: 'Thawed Grill', area: '' }, dish: 'burger', score: 6 })).status === 200);
    const beforeRestart = await matt.state();
    await stop(server);
    await sleep(500);
    // Pretend everyone signed in ten days ago, and that a photo was left behind long ago.
    const DAY = 24 * 60 * 60 * 1000;
    const stale = '00000000-0000-4000-8000-00000000beef';
    const sql = (database, command) => wrangler(['d1', 'execute', database, '--local', '--persist-to', state, '--command', command]);
    sql('char-and-crouton', `UPDATE sessions SET expires = ${Date.now() + 80 * DAY}`);
    sql('char-and-crouton-photos', `INSERT INTO photos (id, bytes) VALUES ('${stale}', x'ffd8ffe0')`);
    server = start();
    await waitUp();
    const renewed = await matt.request('/api/state');
    ok('using the app renews the sign-in', /Max-Age=7776000/.test(renewed.headers.get('set-cookie') || ''));
    ok('a sign-in renews at most once a day', !(await matt.request('/api/state')).headers.get('set-cookie'));
    const afterRestart = await matt.state();
    ok('everything and sign-ins survive a restart', JSON.stringify(afterRestart.ratings) === JSON.stringify(beforeRestart.ratings));
    ok('the left-behind photo is there to begin with', (await matt.request(`/photos/${stale}.jpg`)).status === 200);
    const fresh = await upload(matt);
    ok('an old photo no rating uses is removed', (await matt.request(`/photos/${stale}.jpg`)).status === 404);
    ok('a recent upload is left alone', (await matt.request(`/photos/${fresh}.jpg`)).status === 200 && (await matt.request(`/photos/${bigId}.jpg`)).status === 200);
    const pulled = host(['pull']).match(/to (.+)$/m)[1].trim();
    const backup = JSON.parse(fs.readFileSync(path.join(pulled, 'ratings.json'), 'utf8'));
    ok('an off-site backup matches', JSON.stringify(backup.ratings) === JSON.stringify(afterRestart.ratings)
      && fs.readFileSync(path.join(pulled, 'photos', `${bigId}.jpg`)).equals(big));
  } catch (err) {
    failures += 1;
    console.error(err);
    if (server) console.error(server.output.split('\n').slice(-20).join('\n'));
  } finally {
    if (server) await stop(server);
    await sleep(500);
    fs.rmSync(state, { recursive: true, force: true, maxRetries: 5 });
    fs.rmSync(homeDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
    process.exitCode = failures ? 1 : 0;
  }
})();
