// Accounts and sessions. A person's name comes from their session, never from what
// a request says, so nobody can post as someone else by typing their name.
const { createHash, randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { findInvite, useInvite } = require('./invites');

const scryptAsync = promisify(scrypt);
const SESSION_DAYS = 90;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function passwordMatches(password, stored) {
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex');
  const actual = await scryptAsync(password, Buffer.from(salt, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

// Behind a host, every visitor seems to come from the host itself. The host adds the real
// address as the last entry, and anything before that could have been typed by the visitor.
function clientAddress(req) {
  const forwarded = process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for'];
  return forwarded ? forwarded.split(',').pop().trim() : req.socket.remoteAddress;
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

module.exports = function createAuth({ db, commit, dataFile, BadRequest, isFrozen }) {
  if (!db.accounts) db.accounts = [];
  if (!db.sessions) db.sessions = [];
  const failures = new Map();

  // While frozen the file must stay exactly as it was copied, so sessions stay in
  // memory. They only cost a sign-in if the app restarts before it unfreezes.
  const saveSession = (change) => (isFrozen() ? change() : commit(change));

  function assertNotLocked(key) {
    const record = failures.get(key);
    if (record && record.count >= MAX_FAILURES && Date.now() < record.until) {
      const error = new BadRequest('Too many tries. Please wait 15 minutes and try again.');
      error.status = 429;
      throw error;
    }
  }

  function noteFailure(key) {
    const record = failures.get(key);
    const count = record && Date.now() < record.until ? record.count + 1 : 1;
    // Made-up names shouldn't be able to grow this forever on a public link.
    if (failures.size > 1000) {
      for (const [other, value] of failures) if (Date.now() >= value.until) failures.delete(other);
    }
    failures.set(key, { count, until: Date.now() + LOCK_MS });
  }

  function validatePassword(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
      throw new BadRequest(`Passwords need at least ${MIN_PASSWORD} characters.`);
    }
    if (password.length > MAX_PASSWORD) throw new BadRequest('That password is too long.');
  }

  function startSession(person) {
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    db.sessions = db.sessions.filter((session) => session.expires > now);
    db.sessions.push({ tokenHash: sha256(token), person, expires: now + SESSION_DAYS * 24 * 60 * 60 * 1000 });
    return token;
  }

  function setSessionCookie(req, res, token, maxAge) {
    // Behind a host's https proxy the browser must only ever send this over https.
    const secure = process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
  }

  function currentPerson(req) {
    const token = readCookie(req, 'session');
    if (!token) return null;
    const tokenHash = sha256(token);
    const session = db.sessions.find((s) => s.tokenHash === tokenHash && s.expires > Date.now());
    return session ? session.person : null;
  }

  async function login(req, res, body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const key = `login:${name.toLowerCase()}`;
    assertNotLocked(key);
    const account = db.accounts.find((a) => a.person.toLowerCase() === name.toLowerCase());
    const matches = account && typeof body.password === 'string' && body.password.length <= MAX_PASSWORD
      && await passwordMatches(body.password, account.password);
    if (!matches) {
      noteFailure(key);
      throw new BadRequest("That name and password don't match. First time here? Use your invite code.");
    }
    failures.delete(key);
    let token;
    saveSession(() => { token = startSession(account.person); });
    setSessionCookie(req, res, token, SESSION_DAYS * 24 * 60 * 60);
  }

  async function claim(req, res, body) {
    if (isFrozen()) {
      const error = new BadRequest('The app is paused, so new accounts have to wait.');
      error.status = 503;
      throw error;
    }
    const key = `claim:${clientAddress(req)}`;
    assertNotLocked(key);
    validatePassword(body.password);
    const invite = findInvite(dataFile, body.code);
    if (!invite) {
      noteFailure(key);
      throw new BadRequest("That invite code isn't valid. It may have been used or expired.");
    }
    const password = await hashPassword(body.password);
    let token;
    commit(() => {
      // Checked again because hashing is slow: two people could get this far with one code.
      if (!findInvite(dataFile, body.code)) throw new BadRequest("That invite code isn't valid. It may have been used or expired.");
      const known = db.people.find((person) => person.toLowerCase() === invite.person.toLowerCase());
      const person = known || invite.person;
      if (!known) db.people.push(person);
      db.accounts = db.accounts.filter((a) => a.person !== person);
      db.accounts.push({ person, password });
      // An invite for an existing account resets it, so old sign-ins must stop working.
      db.sessions = db.sessions.filter((s) => s.person !== person);
      token = startSession(person);
      return () => useInvite(dataFile, invite);
    });
    failures.delete(key);
    setSessionCookie(req, res, token, SESSION_DAYS * 24 * 60 * 60);
  }

  function logout(req, res) {
    const token = readCookie(req, 'session');
    if (token) {
      const tokenHash = sha256(token);
      saveSession(() => { db.sessions = db.sessions.filter((s) => s.tokenHash !== tokenHash); });
    }
    setSessionCookie(req, res, '', 0);
  }

  return { currentPerson, login, claim, logout };
};
