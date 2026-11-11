// Accounts, sessions and invite codes for the Cloudflare version. The same rules as lib/auth.js:
// a person's name comes from their session, never from what a request says.
import shared from '../lib/shared.js';

const { BadRequest } = shared;
const SESSION_DAYS = 90;
const INVITE_DAYS = 7;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
// No 0/O or 1/I/L, since these get read off a screen and typed on a phone.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (text) => new Uint8Array(text.match(/../g).map((pair) => parseInt(pair, 16)));
export const sha256 = async (text) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const normalizeCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Compares without stopping at the first difference, so timing reveals nothing.
export function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

async function hashPassword(password, iterations) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${iterations}$${hex(salt)}$${await derive(password, salt, iterations)}`;
}

// Passwords set on the home version use a method Cloudflare's free plan is too slow for.
const isPortable = (stored) => stored.startsWith('pbkdf2$');

async function passwordMatches(password, stored) {
  const [, iterations, salt, hash] = stored.split('$');
  return sameText(await derive(password, fromHex(salt), Number(iterations)), hash);
}

function readCookie(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

export function sessionCookie(request, token, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

// Cloudflare sets this header itself, so visitors can't fake it.
export const clientAddress = (request) => request.headers.get('CF-Connecting-IP') || 'unknown';

export async function isFrozen(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'frozen'").first();
  return row ? row.value : null;
}

async function assertNotLocked(env, key) {
  const row = await env.DB.prepare('SELECT count, until FROM failures WHERE key = ?').bind(key).first();
  if (row && row.count >= MAX_FAILURES && Date.now() < row.until) {
    throw new BadRequest('Too many tries. Please wait 15 minutes and try again.', 429);
  }
}

async function noteFailure(env, key) {
  const now = Date.now();
  await env.DB.batch([
    // Made-up names shouldn't be able to grow this table forever.
    env.DB.prepare('DELETE FROM failures WHERE until < ?').bind(now),
    env.DB.prepare(`INSERT INTO failures (key, count, until) VALUES (?, 1, ?)
      ON CONFLICT (key) DO UPDATE SET count = count + 1, until = excluded.until`).bind(key, now + LOCK_MS),
  ]);
}

const clearFailures = (env, key) => env.DB.prepare('DELETE FROM failures WHERE key = ?').bind(key).run();

export async function currentPerson(env, request) {
  const token = readCookie(request, 'session');
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await env.DB.prepare('SELECT person FROM sessions WHERE token_hash = ? AND expires > ?')
    .bind(await sha256(token), Date.now()).first();
  return row ? row.person : null;
}

async function sessionStatements(env, person) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  return {
    token,
    statements: [
      env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(now),
      env.DB.prepare('INSERT INTO sessions (token_hash, person, expires) VALUES (?, ?, ?)')
        .bind(await sha256(token), person, now + SESSION_DAYS * 24 * 60 * 60 * 1000),
    ],
  };
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new BadRequest(`Passwords need at least ${MIN_PASSWORD} characters.`);
  }
  if (password.length > MAX_PASSWORD) throw new BadRequest('That password is too long.');
}

// Returns the new session token.
export async function login(env, body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const key = `login:${name.toLowerCase()}`;
  await assertNotLocked(env, key);
  const account = await env.DB.prepare('SELECT person, password FROM accounts WHERE lower(person) = lower(?)').bind(name).first();
  if (account && !isPortable(account.password)) {
    throw new BadRequest('Since the move, your password needs setting again. Ask for a new invite code.');
  }
  const matches = account && typeof body.password === 'string' && body.password.length <= MAX_PASSWORD
    && await passwordMatches(body.password, account.password);
  if (!matches) {
    await noteFailure(env, key);
    throw new BadRequest("That name and password don't match. First time here? Use your invite code.");
  }
  await clearFailures(env, key);
  const { token, statements } = await sessionStatements(env, account.person);
  await env.DB.batch(statements);
  return token;
}

export async function claim(env, request, body) {
  if (await isFrozen(env)) throw new BadRequest('The app is paused, so new accounts have to wait.', 503);
  const key = `claim:${clientAddress(request)}`;
  await assertNotLocked(env, key);
  validatePassword(body.password);
  const codeHash = await sha256(normalizeCode(body.code));
  const valid = await env.DB.prepare('SELECT 1 FROM invites WHERE code_hash = ? AND expires > ?').bind(codeHash, Date.now()).first();
  if (!valid) {
    await noteFailure(env, key);
    throw new BadRequest("That invite code isn't valid. It may have been used or expired.");
  }
  const password = await hashPassword(body.password, Number(env.PASSWORD_ITERATIONS) || 100000);
  // Removing the code is what claims it, so two people using one code at once can't both get in.
  const used = await env.DB.prepare('DELETE FROM invites WHERE code_hash = ? AND expires > ? RETURNING person')
    .bind(codeHash, Date.now()).first();
  if (!used) throw new BadRequest("That invite code isn't valid. It may have been used or expired.");
  const known = await env.DB.prepare('SELECT name FROM people WHERE lower(name) = lower(?)').bind(used.person).first();
  const person = known ? known.name : used.person;
  const { token, statements } = await sessionStatements(env, person);
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO people (name) VALUES (?)').bind(person),
    env.DB.prepare('INSERT INTO accounts (person, password) VALUES (?, ?) ON CONFLICT (person) DO UPDATE SET password = excluded.password')
      .bind(person, password),
    // An invite for an existing account resets it, so old sign-ins must stop working.
    env.DB.prepare('DELETE FROM sessions WHERE person = ?').bind(person),
    ...statements,
  ]);
  await clearFailures(env, key);
  return token;
}

export async function logout(env, request) {
  const token = readCookie(request, 'session');
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
}

export async function createInvite(env, typed) {
  const known = await env.DB.prepare('SELECT name FROM people WHERE lower(name) = lower(?)').bind(typed).first();
  const person = known ? known.name : typed;
  let code = '';
  while (code.length < 12) {
    const [byte] = crypto.getRandomValues(new Uint8Array(1));
    // Skipping high values keeps every letter equally likely.
    if (byte < 248) code += ALPHABET[byte % ALPHABET.length];
  }
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM invites WHERE expires < ? OR lower(person) = lower(?)').bind(now, person),
    env.DB.prepare('INSERT INTO invites (code_hash, person, expires) VALUES (?, ?, ?)')
      .bind(await sha256(code), person, now + INVITE_DAYS * 24 * 60 * 60 * 1000),
  ]);
  return { person, code: code.match(/.{4}/g).join('-'), days: INVITE_DAYS };
}
