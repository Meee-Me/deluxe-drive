// Deluxe Main: the one server every Deluxe website signs in with.
//
//   - accounts: the only place a Deluxe account is ever made,
//   - sessions: Deluxe Main's own, and one per website a person signed in to,
//   - data: everything the websites save (settings, histories, Deluxe Drive's
//     folder and file list, mail), kept per account and per website.
//
// File contents are the one thing kept elsewhere: they stay in Deluxe Drive,
// which checks every request with this server.
//
// Nothing here touches Node APIs: it takes a SQL handle and an env, so the same
// code runs in the Durable Object and in the local tests.

import { APPS, appForOrigin, publicApps } from './apps.js';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;
const HEX_PATTERN = /^[0-9a-fA-F]{16,128}$/;
const DATA_KEY = /^[A-Za-z0-9_.:@/-]{1,200}$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,22}[A-Za-z0-9]$/;
// Sign-ins are saved: a key lasts 180 days and every use pushes that back,
// so someone who keeps using a site stays signed in.
const MAIN_SESSION_SECONDS = 180 * 24 * 60 * 60;
const APP_SESSION_SECONDS = 180 * 24 * 60 * 60;
const CODE_SECONDS = 60;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_VALUE_BYTES = 1024 * 1024;
const MAX_LIST = 5000;

const encoder = new TextEncoder();

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS accounts (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, name_lc TEXT NOT NULL UNIQUE, handle TEXT NOT NULL UNIQUE,
     salt TEXT NOT NULL, verifier TEXT NOT NULL, created_at INTEGER, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, app TEXT NOT NULL,
     created_at INTEGER, expires_at INTEGER, last_seen INTEGER)`,
  `CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account_id, app)`,
  `CREATE TABLE IF NOT EXISTS grants (account_id TEXT NOT NULL, app TEXT NOT NULL, created_at INTEGER, PRIMARY KEY (account_id, app))`,
  `CREATE TABLE IF NOT EXISTS codes (
     code_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, app TEXT NOT NULL, origin TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS data (
     account_id TEXT NOT NULL, app TEXT NOT NULL, key TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER,
     PRIMARY KEY (account_id, app, key))`,
];

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function toHex(bytes) {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function randomToken(byteLength) {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function sha256(value) {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(String(value))));
}

function safeEqual(left, right) {
  const a = encoder.encode(String(left || ''));
  const b = encoder.encode(String(right || ''));
  if (!a.length || a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

function fail(message, status, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function bearerToken(request) {
  const match = /^Bearer\s+(.+)$/i.exec(String(request.headers.get('authorization') || ''));
  return match ? match[1].trim() : '';
}

async function readJsonBody(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_JSON_BYTES) throw fail('That request is too large.', 413);
  const raw = await request.text();
  if (raw.length > MAX_JSON_BYTES) throw fail('That request is too large.', 413);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    throw fail('That request could not be read.', 400);
  }
}

// The visitor's address, for slowing down repeated tries. Deluxe Main's pages
// on Vercel pass requests on, so Cloudflare sees Vercel's address; Vercel puts
// the visitor's own in x-vercel-forwarded-for / x-forwarded-for.
function clientIp(request) {
  const forwarded = request.headers.get('x-vercel-forwarded-for') || request.headers.get('x-forwarded-for') || '';
  return forwarded.split(',')[0].trim() || request.headers.get('cf-connecting-ip') || 'unknown';
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return value;
  }
}

// The short address used where a plain name is needed, such as a
// name@deluxemail.com address: "Shivad Sujith" becomes "shivad.sujith".
export function handleFor(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[._-]+|[._-]+$/g, '')
    .replace(/\.{2,}/g, '.')
    .slice(0, 30);
}

function publicUser(account) {
  return { id: account.id, name: account.name, handle: account.handle };
}

/* ------------------------------------------------------------------ */
/* The server                                                          */
/* ------------------------------------------------------------------ */

export class MainCore {
  // options.drive(path, init) talks to Deluxe Drive; the Worker passes a
  // function that uses the DRIVE service binding or DRIVE_URL.
  constructor(sql, env, options = {}) {
    this.sql = sql;
    this.env = env || {};
    this.driveCall = options.drive || null;
    this.failures = new Map();
    for (const statement of SCHEMA) this.sql.exec(statement);
    this.routes = [];
    this.defineRoutes();
  }

  all(query, ...params) {
    return this.sql.exec(query, ...params).toArray();
  }

  one(query, ...params) {
    return this.all(query, ...params)[0] || null;
  }

  run(query, ...params) {
    this.sql.exec(query, ...params);
  }

  async drive(path, init) {
    if (!this.driveCall) return null;
    try {
      return await this.driveCall(path, init);
    } catch (error) {
      console.error('Deluxe Drive did not answer:', path, error);
      return null;
    }
  }

  /* ---------------- rate limits ---------------- */

  tooManyFailures(key) {
    const entry = this.failures.get(key);
    return !!entry && entry.count >= 8 && entry.until > Date.now();
  }

  noteFailure(key) {
    const now = Date.now();
    const entry = this.failures.get(key);
    if (!entry || entry.until <= now) this.failures.set(key, { count: 1, until: now + 10 * 60 * 1000 });
    else entry.count += 1;
    if (this.failures.size > 5000) {
      for (const [name, value] of this.failures) if (value.until <= now) this.failures.delete(name);
    }
  }

  clearFailures(key) {
    this.failures.delete(key);
  }

  /* ---------------- accounts ---------------- */

  accountById(id) {
    if (!ID_PATTERN.test(String(id || ''))) return null;
    return this.one(`SELECT * FROM accounts WHERE id = ?`, id);
  }

  accountByName(name) {
    const clean = String(name || '').trim().toLowerCase();
    if (!clean) return null;
    return this.one(`SELECT * FROM accounts WHERE name_lc = ?`, clean);
  }

  accountByHandle(handle) {
    const clean = String(handle || '').trim().toLowerCase();
    if (!clean) return null;
    return this.one(`SELECT * FROM accounts WHERE handle = ?`, clean);
  }

  async verifierFor(hash) {
    return sha256(`deluxe-main:${String(hash || '').toLowerCase()}`);
  }

  async insertAccount({ id, name, salt, hash, handle }) {
    const now = Date.now();
    this.run(
      `INSERT INTO accounts (id, name, name_lc, handle, salt, verifier, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      name,
      name.toLowerCase(),
      handle,
      salt,
      await this.verifierFor(hash),
      now,
      now
    );
    return this.accountById(id);
  }

  async createAccount({ name, salt, hash }) {
    const cleanName = String(name || '').trim().replace(/\s+/g, ' ');
    if (!NAME_PATTERN.test(cleanName)) {
      throw fail('Use 3 to 24 letters, numbers, spaces, dots, dashes or underscores for the name.', 400, 'bad-name');
    }
    if (!HEX_PATTERN.test(String(salt || '')) || !HEX_PATTERN.test(String(hash || ''))) {
      throw fail('That account record is not valid.', 400);
    }
    const handle = handleFor(cleanName);
    if (handle.length < 3) throw fail('That name needs at least 3 letters or numbers.', 400, 'bad-name');
    if (this.accountByName(cleanName) || this.accountByHandle(handle)) {
      throw fail('That name is already used. Choose another.', 409, 'name-taken');
    }
    // A name still sitting in an old Deluxe Drive account is taken too, so it
    // can be moved to Deluxe Main by its owner later.
    const legacy = await this.drive('/api/legacy/exists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: cleanName }),
    });
    if (legacy && legacy.ok) {
      const data = await legacy.json().catch(() => ({}));
      if (data && data.exists) throw fail('That name is already used. Choose another.', 409, 'name-taken');
    }
    const id = `u_${Date.now().toString(36)}_${randomToken(3)}`;
    return this.insertAccount({ id, name: cleanName, salt, hash, handle });
  }

  // Accounts made in Deluxe Drive before Deluxe Main existed move here the
  // first time their owner signs in: Drive checks the password and hands the
  // account over, keeping its id so its files stay where they are.
  async claimLegacy(name, hash) {
    const response = await this.drive('/api/legacy/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, hash }),
    });
    if (!response || !response.ok) return null;
    const data = await response.json().catch(() => null);
    if (!data || !ID_PATTERN.test(String(data.id || '')) || !HEX_PATTERN.test(String(data.salt || ''))) return null;
    if (this.accountById(data.id)) return this.accountById(data.id);

    const cleanName = String(data.name || name).trim().slice(0, 24) || 'Deluxe user';
    let finalName = cleanName;
    if (this.accountByName(finalName)) finalName = `${cleanName.slice(0, 18)} ${randomToken(2)}`;
    let handle = handleFor(finalName);
    if (handle.length < 3 || this.accountByHandle(handle)) handle = `user-${randomToken(4)}`;
    return this.insertAccount({ id: data.id, name: finalName, salt: data.salt, hash, handle });
  }

  async fakeSalt(name) {
    let secret = this.env.DELUXE_FAKE_SECRET || '';
    if (!secret) {
      const row = this.one(`SELECT value FROM meta WHERE key = 'fake-secret'`);
      if (row) secret = row.value;
      else {
        secret = randomToken(24);
        this.run(`INSERT OR IGNORE INTO meta (key, value) VALUES ('fake-secret', ?)`, secret);
      }
    }
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(String(name).trim().toLowerCase())));
    return digest.slice(0, 32);
  }

  // The salt to hash a password with. A name nobody owns still gets a steady,
  // plausible salt, so this cannot be used to find out who has an account.
  async saltFor(name) {
    const account = this.accountByName(name);
    if (account) return account.salt;
    const response = await this.drive('/api/accounts/find', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (response && response.ok) {
      const data = await response.json().catch(() => null);
      if (data && HEX_PATTERN.test(String(data.salt || ''))) return data.salt;
    }
    return this.fakeSalt(name);
  }

  async checkPassword(account, hash) {
    return !!account && safeEqual(account.verifier, await this.verifierFor(hash));
  }

  async deleteAccount(id) {
    this.run(`DELETE FROM accounts WHERE id = ?`, id);
    for (const table of ['sessions', 'grants', 'codes', 'data']) this.run(`DELETE FROM ${table} WHERE account_id = ?`, id);
  }

  /* ---------------- sessions ---------------- */

  async createSession(accountId, app, ttlSeconds) {
    const now = Date.now();
    this.run(`DELETE FROM sessions WHERE expires_at <= ?`, now);
    const token = `dm_${randomToken(32)}`;
    this.run(
      `INSERT INTO sessions (token_hash, account_id, app, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)`,
      await sha256(token),
      accountId,
      app,
      now,
      now + ttlSeconds * 1000,
      now
    );
    return { token, expiresIn: ttlSeconds };
  }

  async sessionFor(token) {
    const clean = String(token || '');
    if (!clean) return null;
    const hash = await sha256(clean);
    const row = this.one(`SELECT * FROM sessions WHERE token_hash = ?`, hash);
    if (!row) return null;
    const now = Date.now();
    if (row.expires_at <= now) {
      this.run(`DELETE FROM sessions WHERE token_hash = ?`, hash);
      return null;
    }
    if (now - (row.last_seen || 0) > 60 * 60 * 1000) {
      const ttl = row.app === 'main' ? MAIN_SESSION_SECONDS : APP_SESSION_SECONDS;
      this.run(`UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?`, now, now + ttl * 1000, hash);
    }
    const account = this.accountById(row.account_id);
    if (!account) return null;
    return { hash, account, app: row.app };
  }

  async dropSession(token) {
    this.run(`DELETE FROM sessions WHERE token_hash = ?`, await sha256(String(token || '')));
  }

  /* ---------------- who is asking ---------------- */

  // A person's session (Bearer), or a website's own server (App key).
  async principal(request) {
    const header = String(request.headers.get('authorization') || '');
    const appKey = /^App\s+(.+)$/i.exec(header);
    if (appKey) {
      const app = String(request.headers.get('x-deluxe-app') || '').toLowerCase();
      const expected = APPS[app] && app !== 'main' ? this.env[`APP_KEY_${app.toUpperCase()}`] : '';
      if (!expected || !safeEqual(expected, appKey[1].trim())) return null;
      const account = this.accountById(request.headers.get('x-deluxe-account'));
      return { kind: 'server', app, account };
    }
    const session = await this.sessionFor(bearerToken(request));
    return session ? { kind: 'session', app: session.app, account: session.account, hash: session.hash } : null;
  }

  async need(request, { mainOnly = false } = {}) {
    const who = await this.principal(request);
    if (!who || (who.kind === 'session' && !who.account)) {
      return [null, json(401, { error: 'Sign in with Deluxe Main again.', code: 'unauthorized' })];
    }
    if (mainOnly && (who.kind !== 'session' || who.app !== 'main')) {
      return [null, json(403, { error: 'Only Deluxe Main itself can do that.', code: 'main-only' })];
    }
    return [who, null];
  }

  canRead(who, app) {
    if (who.app === 'main' || who.app === app) return true;
    return !!APPS[who.app] && APPS[who.app].reads.includes(app);
  }

  canWrite(who, app) {
    return who.app === 'main' || who.app === app;
  }

  /* ---------------- data ---------------- */

  listData(accountId, app, { prefix = '', desc = false, limit = MAX_LIST, values = true } = {}) {
    const count = Math.max(1, Math.min(MAX_LIST, Number(limit) || MAX_LIST));
    const rows = this.all(
      `SELECT key, ${values ? 'json,' : ''} updated_at FROM data
       WHERE account_id = ? AND app = ? AND substr(key, 1, ?) = ?
       ORDER BY key ${desc ? 'DESC' : 'ASC'} LIMIT ?`,
      accountId,
      app,
      prefix.length,
      prefix,
      count
    );
    return rows.map((row) => ({
      key: row.key,
      ...(values ? { value: JSON.parse(row.json) } : {}),
      updatedAt: row.updated_at,
    }));
  }

  getData(accountId, app, key) {
    const row = this.one(`SELECT json, updated_at FROM data WHERE account_id = ? AND app = ? AND key = ?`, accountId, app, key);
    return row ? { value: JSON.parse(row.json), updatedAt: row.updated_at } : undefined;
  }

  putData(accountId, app, key, value) {
    if (!DATA_KEY.test(String(key || ''))) throw fail('That data key is not valid.', 400);
    const text = JSON.stringify(value === undefined ? null : value);
    if (text.length > MAX_VALUE_BYTES) throw fail('That is too much to save in one item.', 413);
    this.run(
      `INSERT INTO data (account_id, app, key, json, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (account_id, app, key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      accountId,
      app,
      key,
      text,
      Date.now()
    );
  }

  deleteData(accountId, app, key) {
    this.run(`DELETE FROM data WHERE account_id = ? AND app = ? AND key = ?`, accountId, app, key);
  }

  clearData(accountId, app, prefix = '') {
    this.run(
      `DELETE FROM data WHERE account_id = ? AND app = ? AND substr(key, 1, ?) = ?`,
      accountId,
      app,
      prefix.length,
      prefix
    );
  }

  usage(accountId) {
    return this.all(
      `SELECT app, COUNT(*) AS items, COALESCE(SUM(LENGTH(json)), 0) AS bytes FROM data WHERE account_id = ? GROUP BY app`,
      accountId
    );
  }

  /* ---------------- sign-in for websites ---------------- */

  // Where a website asked to be sent back to, and which app that is.
  target(returnUrl, asked) {
    let url;
    try {
      url = new URL(String(returnUrl || ''));
    } catch (error) {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const app = appForOrigin(url.origin, this.env, String(asked || ''));
    if (!app) return null;
    url.hash = '';
    return { app, origin: url.origin, url };
  }

  async createCode(accountId, app, origin) {
    const now = Date.now();
    this.run(`DELETE FROM codes WHERE expires_at <= ? OR (account_id = ? AND app = ?)`, now, accountId, app);
    const code = randomToken(24);
    this.run(
      `INSERT INTO codes (code_hash, account_id, app, origin, expires_at) VALUES (?, ?, ?, ?, ?)`,
      await sha256(`code:${code}`),
      accountId,
      app,
      origin,
      now + CODE_SECONDS * 1000
    );
    return code;
  }

  async takeCode(code) {
    if (!/^[0-9a-f]{48}$/.test(String(code || ''))) return null;
    const hash = await sha256(`code:${code}`);
    const row = this.one(`SELECT * FROM codes WHERE code_hash = ?`, hash);
    if (!row) return null;
    this.run(`DELETE FROM codes WHERE code_hash = ?`, hash);
    if (row.expires_at <= Date.now()) return null;
    return row;
  }

  /* ---------------- routes ---------------- */

  route(method, pattern, handler) {
    this.routes.push({ method, segments: pattern.split('/').filter(Boolean), handler });
  }

  matchRoute(method, segments) {
    for (const entry of this.routes) {
      if (entry.method !== method || entry.segments.length !== segments.length) continue;
      const params = {};
      let matched = true;
      for (let index = 0; index < segments.length; index += 1) {
        const expected = entry.segments[index];
        if (expected.startsWith(':')) params[expected.slice(1)] = segments[index];
        else if (expected !== segments[index]) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: entry.handler, params };
    }
    return null;
  }

  async signedIn(account, status = 200) {
    const session = await this.createSession(account.id, 'main', MAIN_SESSION_SECONDS);
    return json(status, { token: session.token, expiresIn: session.expiresIn, user: publicUser(account) });
  }

  defineRoutes() {
    const r = (method, pattern, handler) => this.route(method, pattern, handler);

    r('GET', '/api/health', () =>
      json(200, { ok: true, name: 'Deluxe Main', server: true, version: 1, apps: publicApps(this.env) })
    );

    r('GET', '/api/apps', () => json(200, { apps: publicApps(this.env) }));

    /* ---- accounts ---- */

    r('POST', '/api/accounts/find', async ({ request }) => {
      const body = await readJsonBody(request);
      const name = String(body.name || '').trim().slice(0, 40);
      if (!name) return json(400, { error: 'Type your account name.' });
      return json(200, { salt: await this.saltFor(name) });
    });

    r('POST', '/api/accounts', async ({ request }) => {
      const ip = clientIp(request);
      if (this.tooManyFailures(`create:${ip}`)) return json(429, { error: 'Too many new accounts. Try again later.' });
      const body = await readJsonBody(request);
      let account;
      try {
        account = await this.createAccount(body);
      } catch (error) {
        return json(error.status || 500, { error: error.status ? error.message : 'That account could not be made.', code: error.code });
      }
      // Counted as a "failure" so one address cannot make hundreds of accounts.
      this.noteFailure(`create:${ip}`);
      return this.signedIn(account, 201);
    });

    r('POST', '/api/auth/login', async ({ request }) => {
      const body = await readJsonBody(request);
      const name = String(body.name || '').trim().slice(0, 40);
      const hash = String(body.hash || '');
      const nameKey = `login:${name.toLowerCase()}`;
      if (this.tooManyFailures(nameKey)) {
        return json(429, { error: 'Too many wrong tries. Wait a few minutes and try again.', code: 'rate-limited' });
      }
      if (!name || !HEX_PATTERN.test(hash)) return json(400, { error: 'Type your name and password.' });

      let account = this.accountByName(name);
      if (account && !(await this.checkPassword(account, hash))) account = null;
      else if (!account) account = await this.claimLegacy(name, hash);

      if (!account) {
        this.noteFailure(nameKey);
        return json(401, { error: "That name and password don't match a Deluxe account.", code: 'unauthorized' });
      }
      this.clearFailures(nameKey);
      return this.signedIn(account);
    });

    r('GET', '/api/auth/me', async ({ request }) => {
      const who = await this.principal(request);
      if (!who || who.kind !== 'session') return json(401, { error: 'Sign in with Deluxe Main again.', code: 'unauthorized' });
      return json(200, {
        user: publicUser(who.account),
        app: who.app,
        expiresIn: who.app === 'main' ? MAIN_SESSION_SECONDS : APP_SESSION_SECONDS,
        reads: who.app === 'main' ? Object.keys(APPS) : [who.app, ...(APPS[who.app] ? APPS[who.app].reads : [])],
      });
    });

    r('POST', '/api/auth/logout', async ({ request }) => {
      const token = bearerToken(request);
      if (token) await this.dropSession(token);
      return json(200, { ok: true });
    });

    r('GET', '/api/account', async ({ request }) => {
      const [who, denied] = await this.need(request, { mainOnly: true });
      if (denied) return denied;
      const sessions = this.all(
        `SELECT app, COUNT(*) AS count, MAX(last_seen) AS last_seen FROM sessions
         WHERE account_id = ? AND app != 'main' AND expires_at > ? GROUP BY app`,
        who.account.id,
        Date.now()
      );
      return json(200, {
        user: publicUser(who.account),
        createdAt: who.account.created_at,
        apps: publicApps(this.env),
        signedIn: sessions.map((row) => ({ app: row.app, name: APPS[row.app] ? APPS[row.app].name : row.app, lastSeen: row.last_seen })),
        usage: this.usage(who.account.id),
      });
    });

    r('PATCH', '/api/account', async ({ request }) => {
      const [who, denied] = await this.need(request, { mainOnly: true });
      if (denied) return denied;
      const body = await readJsonBody(request);
      const name = String(body.name || '').trim().replace(/\s+/g, ' ');
      if (!NAME_PATTERN.test(name)) {
        return json(400, { error: 'Use 3 to 24 letters, numbers, spaces, dots, dashes or underscores for the name.' });
      }
      const other = this.accountByName(name);
      if (other && other.id !== who.account.id) return json(409, { error: 'That name is already used. Choose another.' });
      // The handle (and so a Deluxe Mail address) never changes after the account is made.
      this.run(`UPDATE accounts SET name = ?, name_lc = ?, updated_at = ? WHERE id = ?`, name, name.toLowerCase(), Date.now(), who.account.id);
      return json(200, { user: publicUser(this.accountById(who.account.id)) });
    });

    r('POST', '/api/account/password', async ({ request }) => {
      const [who, denied] = await this.need(request, { mainOnly: true });
      if (denied) return denied;
      const body = await readJsonBody(request);
      if (!(await this.checkPassword(who.account, body.currentHash))) {
        return json(401, { error: 'That password is not correct.', code: 'wrong-password' });
      }
      if (!HEX_PATTERN.test(String(body.salt || '')) || !HEX_PATTERN.test(String(body.hash || ''))) {
        return json(400, { error: 'That password could not be saved.' });
      }
      this.run(
        `UPDATE accounts SET salt = ?, verifier = ?, updated_at = ? WHERE id = ?`,
        body.salt,
        await this.verifierFor(body.hash),
        Date.now(),
        who.account.id
      );
      // Every other sign-in ends; this one stays.
      this.run(`DELETE FROM sessions WHERE account_id = ? AND token_hash != ?`, who.account.id, who.hash);
      return json(200, { ok: true });
    });

    r('DELETE', '/api/account/sessions/:app', async ({ request, params }) => {
      const [who, denied] = await this.need(request, { mainOnly: true });
      if (denied) return denied;
      if (params.app === 'main') {
        this.run(`DELETE FROM sessions WHERE account_id = ? AND app = 'main' AND token_hash != ?`, who.account.id, who.hash);
      } else {
        this.run(`DELETE FROM sessions WHERE account_id = ? AND app = ?`, who.account.id, params.app);
        this.run(`DELETE FROM grants WHERE account_id = ? AND app = ?`, who.account.id, params.app);
      }
      return json(200, { ok: true });
    });

    // Deleting the account also empties its Deluxe Drive (the files there).
    r('POST', '/api/account/delete', async ({ request }) => {
      const [who, denied] = await this.need(request, { mainOnly: true });
      if (denied) return denied;
      const body = await readJsonBody(request);
      if (!(await this.checkPassword(who.account, body.hash))) {
        return json(401, { error: 'That password is not correct.', code: 'wrong-password' });
      }
      const cleared = await this.drive('/api/db/clear', {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearerToken(request)}` },
      });
      if (this.driveCall && (!cleared || !cleared.ok)) {
        return json(502, { error: 'Deluxe Drive could not delete your files just now, so nothing was deleted. Try again.' });
      }
      await this.deleteAccount(who.account.id);
      return json(200, { ok: true });
    });

    /* ---- signing in to the other websites ---- */

    // Deluxe Main's page asks what a website is before showing "Continue".
    r('POST', '/api/connect/check', async ({ request }) => {
      const [who, denied] = await this.need(request, { mainOnly: true });
      if (denied) return denied;
      const body = await readJsonBody(request);
      const target = this.target(body.return, body.app);
      if (!target) return json(400, { error: 'That website is not a Deluxe website, so it cannot use your Deluxe account.', code: 'unknown-site' });
      const granted = !!this.one(`SELECT 1 AS ok FROM grants WHERE account_id = ? AND app = ?`, who.account.id, target.app);
      return json(200, { app: target.app, name: APPS[target.app].name, origin: target.origin, approved: granted });
    });

    r('POST', '/api/connect/approve', async ({ request }) => {
      const [who, denied] = await this.need(request, { mainOnly: true });
      if (denied) return denied;
      const body = await readJsonBody(request);
      const target = this.target(body.return, body.app);
      if (!target) return json(400, { error: 'That website is not a Deluxe website.', code: 'unknown-site' });
      this.run(`INSERT OR IGNORE INTO grants (account_id, app, created_at) VALUES (?, ?, ?)`, who.account.id, target.app, Date.now());
      const code = await this.createCode(who.account.id, target.app, target.origin);
      const back = new URL(target.url);
      back.hash = `deluxe_code=${code}`;
      return json(200, { redirect: back.toString(), app: target.app });
    });

    // The website trades the one-use code for its own key. Only the website the
    // code was made for (its Origin) can do that, within 60 seconds.
    r('POST', '/api/connect/exchange', async ({ request }) => {
      const origin = String(request.headers.get('origin') || '').toLowerCase();
      const ip = clientIp(request);
      if (this.tooManyFailures(`exchange:${ip}`)) return json(429, { error: 'Too many tries. Wait a few minutes.' });
      const body = await readJsonBody(request);
      const row = await this.takeCode(body.code);
      if (!row || row.origin !== origin) {
        this.noteFailure(`exchange:${ip}`);
        return json(400, { error: 'That sign-in has run out. Sign in again.', code: 'bad-code' });
      }
      const account = this.accountById(row.account_id);
      if (!account) return json(400, { error: 'That account is gone.', code: 'bad-code' });
      const session = await this.createSession(account.id, row.app, APP_SESSION_SECONDS);
      return json(200, { token: session.token, expiresIn: session.expiresIn, app: row.app, user: publicUser(account) });
    });

    /* ---- data the websites save ---- */

    const dataAccess = async (request, app, writing) => {
      if (!APPS[app]) return [null, json(404, { error: 'There is no Deluxe website called that.' })];
      const [who, denied] = await this.need(request);
      if (denied) return [null, denied];
      if (!who.account) return [null, json(404, { error: 'That account is not here.', code: 'no-account' })];
      if (writing ? !this.canWrite(who, app) : !this.canRead(who, app)) {
        return [null, json(403, { error: `This website cannot ${writing ? 'change' : 'read'} ${APPS[app].name} data.`, code: 'forbidden' })];
      }
      return [who, null];
    };

    r('GET', '/api/data/:app', async ({ request, params, url }) => {
      const [who, denied] = await dataAccess(request, params.app, false);
      if (denied) return denied;
      const items = this.listData(who.account.id, params.app, {
        prefix: url.searchParams.get('prefix') || '',
        desc: url.searchParams.get('order') === 'desc',
        limit: url.searchParams.get('limit'),
        values: url.searchParams.get('values') !== '0',
      });
      return json(200, { items });
    });

    r('DELETE', '/api/data/:app', async ({ request, params, url }) => {
      const [who, denied] = await dataAccess(request, params.app, true);
      if (denied) return denied;
      this.clearData(who.account.id, params.app, url.searchParams.get('prefix') || '');
      return json(200, { ok: true });
    });

    r('POST', '/api/data/:app/batch', async ({ request, params }) => {
      const [who, denied] = await dataAccess(request, params.app, true);
      if (denied) return denied;
      const body = await readJsonBody(request);
      const puts = Array.isArray(body.put) ? body.put : [];
      const deletes = Array.isArray(body.delete) ? body.delete : [];
      for (const item of puts) {
        if (!item || !DATA_KEY.test(String(item.key || ''))) return json(400, { error: 'One of those data keys is not valid.' });
      }
      try {
        for (const item of puts) this.putData(who.account.id, params.app, item.key, item.value);
      } catch (error) {
        return json(error.status || 400, { error: error.message });
      }
      for (const key of deletes) if (DATA_KEY.test(String(key || ''))) this.deleteData(who.account.id, params.app, key);
      return json(200, { ok: true, put: puts.length, deleted: deletes.length });
    });

    r('GET', '/api/data/:app/:key', async ({ request, params }) => {
      const [who, denied] = await dataAccess(request, params.app, false);
      if (denied) return denied;
      const item = this.getData(who.account.id, params.app, params.key);
      return item ? json(200, { key: params.key, ...item }) : json(404, { error: 'Nothing is saved there.' });
    });

    r('PUT', '/api/data/:app/:key', async ({ request, params }) => {
      const [who, denied] = await dataAccess(request, params.app, true);
      if (denied) return denied;
      const body = await readJsonBody(request);
      try {
        this.putData(who.account.id, params.app, params.key, body.value);
      } catch (error) {
        return json(error.status || 400, { error: error.message });
      }
      return json(200, { ok: true, key: params.key });
    });

    r('DELETE', '/api/data/:app/:key', async ({ request, params }) => {
      const [who, denied] = await dataAccess(request, params.app, true);
      if (denied) return denied;
      this.deleteData(who.account.id, params.app, params.key);
      return json(200, { ok: true });
    });

    /* ---- for a website's own server (App key) ---- */

    // Finds an account by its handle, e.g. to deliver mail to name@deluxemail.com.
    r('GET', '/api/server/account', async ({ request, url }) => {
      const who = await this.principal(request);
      if (!who || who.kind !== 'server') return json(401, { error: 'A website key is needed.' });
      const account = this.accountByHandle(url.searchParams.get('handle')) || this.accountById(url.searchParams.get('id'));
      return account ? json(200, { user: publicUser(account) }) : json(404, { error: 'No account by that name.' });
    });
  }

  async handle(request) {
    try {
      const url = new URL(request.url);
      const segments = url.pathname.split('/').filter(Boolean).map(decodeSegment);
      // A data key may contain "/", so everything after /api/data/:app/ is the key.
      let match;
      if (segments[0] === 'api' && segments[1] === 'data' && segments.length > 4) {
        const key = segments.slice(3).join('/');
        match = this.matchRoute(request.method, ['api', 'data', segments[2], key]);
      } else {
        match = this.matchRoute(request.method, segments);
      }
      if (!match) return json(404, { error: 'There is nothing at that address.' });
      return await match.handler({ request, url, params: match.params });
    } catch (error) {
      console.error('Request failed:', request.method, request.url, error);
      return json(error.status || 500, { error: error.status ? error.message : 'Deluxe Main could not answer that.' });
    }
  }
}
