// Takes the phone screenshots in docs/screenshots, using made-up people and places
// from demo-data.json, so no real ratings or names ever end up in them.
// Needs Edge or Chrome: set BROWSER to its path if it isn't found.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const APP = path.join(__dirname, '..');
const OUT = path.join(APP, 'docs', 'screenshots');
const PORT = 4180;
const DEBUG_PORT = 9334;
const base = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = process.env.BROWSER || [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => fs.existsSync(p));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burger-shots-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'burger-shots-profile-'));
  const dataFile = path.join(dir, 'ratings.json');
  fs.copyFileSync(path.join(__dirname, 'demo-data.json'), dataFile);
  const env = { ...process.env, DATA_FILE: dataFile, PORT: String(PORT), ADMIN_TOKEN: '', TRUST_PROXY: '' };
  const code = execFileSync('node', ['scripts/invite.js', 'Alex'], { cwd: APP, env, encoding: 'utf8' }).match(/Code: (\S+)/)[1];
  const server = spawn('node', ['server.js'], { cwd: APP, env, stdio: 'ignore' });
  const chrome = spawn(browser, ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });

  try {
    let targets;
    for (let i = 0; i < 40 && !targets; i += 1) {
      await sleep(250);
      try { targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json(); } catch { /* starting */ }
    }
    const socket = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => { socket.onopen = r; });
    let id = 0;
    const pending = new Map();
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id && pending.has(message.id)) { pending.get(message.id)(message.result); pending.delete(message.id); }
    };
    const send = (method, params = {}) => new Promise((r) => { id += 1; pending.set(id, r); socket.send(JSON.stringify({ id, method, params })); });
    const run = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
    const shot = async (name) => {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
      console.log(`saved ${name}.png`);
    };

    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    await send('Page.enable');
    await send('Page.navigate', { url: base });
    await sleep(2500);
    const password = randomBytes(12).toString('hex');
    await run(`fetch('/api/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: ${JSON.stringify(code)}, password: ${JSON.stringify(password)} }) }).then((r) => r.status)`);
    fs.mkdirSync(OUT, { recursive: true });

    const ready = 'document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 800)))';
    await send('Page.navigate', { url: base });
    await sleep(2500);
    await run(`document.querySelector('.tab[data-dish=burger]').click(); window.scrollTo(0, 0); ${ready}`);
    await shot('burgers');

    await run(`(async () => {
      document.querySelector('[data-toggle]').click();
      ${ready};
    })()`);
    await shot('burger-details');

    await run(`(async () => {
      document.querySelector('[data-toggle][aria-expanded=true]').click();
      document.querySelector('.tab[data-dish=caesar]').click();
      window.scrollTo(0, 0);
      await ${ready};
    })()`);
    await shot('caesars');

    await run(`(async () => {
      document.getElementById('rateButton').click();
      const input = document.getElementById('restaurantInput');
      input.value = 'Patty';
      input.dispatchEvent(new Event('input'));
      await new Promise((r) => setTimeout(r, 300));
      document.querySelector('#restaurantList [data-kind=restaurant]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      document.querySelector('input[name=dish][value=caesar]').click();
      const score = document.getElementById('scoreInput');
      score.value = '8.6';
      score.dispatchEvent(new Event('input'));
      score.dispatchEvent(new Event('blur'));
      document.getElementById('noteInput').value = 'Dressing on point, needs more croutons.';
      document.activeElement.blur();
      await ${ready};
    })()`);
    await shot('rating');

    await run(`(async () => {
      document.getElementById('rateDialog').close();
      document.querySelector('.tab[data-dish=map]').click();
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 4000));
    })()`);
    await shot('map');
    socket.close();
  } finally {
    // The browser starts helper processes, so the whole tree has to go before its folder can be removed.
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
    else chrome.kill();
    server.kill();
    await sleep(2000);
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      console.log(`Couldn't remove the browser's temporary folder: ${profile}`);
    }
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
