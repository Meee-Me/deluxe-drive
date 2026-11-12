// The Deluxe Drive server, for Cloudflare Workers.
//
// Deluxe Drive keeps file contents, and nothing else:
//   - accounts and sign-in belong to Deluxe Main. Every request carries a key
//     Deluxe Main gave out, and this server asks Deluxe Main whose it is
//     (GET /api/auth/me). No account is ever made here.
//   - the folder and file list, settings and everything else are saved in
//     Deluxe Main too (by the drive's page, js/cloud.js).
//   - file contents live in the Durable Object's database in 1 MB pieces, or
//     in R2 when a bucket is bound as FILES, along with share links.
//
// Accounts made here before Deluxe Main existed are handed to Deluxe Main the
// first time their owner signs in there (/api/legacy/claim), keeping their id
// so their files stay put; their old file list is then moved by the page.
//
// Nothing in here touches Node APIs. It takes a SQL handle and an env, so the
// same code runs in the Durable Object and in the local tests.


const SERVER_NAME = 'Deluxe Drive';
const VERIFY_CACHE_MS = 60 * 1000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;
const HEX_PATTERN = /^[0-9a-fA-F]{16,128}$/;
const SETTINGS_KEY = /^[A-Za-z0-9_.-]{1,60}$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

const encoder = new TextEncoder();

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS accounts (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, name_lc TEXT NOT NULL UNIQUE,
     salt TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS nodes (
     account_id TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (account_id, id))`,
  `CREATE TABLE IF NOT EXISTS settings (
     account_id TEXT NOT NULL, key TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (account_id, key))`,
  `CREATE TABLE IF NOT EXISTS blobs (
     account_id TEXT NOT NULL, id TEXT NOT NULL, mime TEXT, size INTEGER, updated_at INTEGER,
     PRIMARY KEY (account_id, id))`,
  `CREATE TABLE IF NOT EXISTS shares (
     token TEXT PRIMARY KEY, account_id TEXT NOT NULL, blob_id TEXT NOT NULL, name TEXT, created_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT, scope TEXT, created_at INTEGER, expires_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS link_codes (
     code_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS chunks (key TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (key, idx))`,
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

function safeEqual(left, right) {
  const a = encoder.encode(String(left || ''));
  const b = encoder.encode(String(right || ''));
  if (!a.length || a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

function requestError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function json(status, value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function text(status, message) {
  return new Response(String(message || ''), {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return value;
  }
}

function bearerToken(request) {
  const match = /^Bearer\s+(.+)$/i.exec(String(request.headers.get('authorization') || ''));
  return match ? match[1].trim() : '';
}

function asciiFilename(name) {
  return String(name || 'file')
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_')
    .slice(0, 180);
}

// "bytes=0-499", "bytes=500-" and "bytes=-500" are the three forms a browser
// sends; anything else is ignored and the whole file is served.
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match) return null;

  const hasStart = match[1] !== '';
  const hasEnd = match[2] !== '';
  if (!hasStart && !hasEnd) return null;

  let start;
  let end;

  if (!hasStart) {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = hasEnd ? Number(match[2]) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start > end || start >= size) return { invalid: true };
  if (end >= size) end = size - 1;

  return { start, end };
}

async function readText(request, limit) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > limit) throw requestError('That request is too large.', 413);
  const body = await request.text();
  if (body.length > limit) throw requestError('That request is too large.', 413);
  return body;
}

async function readJsonBody(request) {
  const raw = await readText(request, MAX_JSON_BYTES);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    throw requestError('That request could not be read.', 400);
  }
}

/* ------------------------------------------------------------------ */
/* File storage: the database by default, R2 when it is bound          */
/* ------------------------------------------------------------------ */

const CHUNK = 1024 * 1024;

function toBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

// Files are cut into 1 MB rows of the Durable Object's SQLite database, so the
// drive works on a free Cloudflare account with nothing to set up.
class SqlStore {
  constructor(sql) {
    this.sql = sql;
    this.name = 'sqlite';
  }

  async put(key, body) {
    this.sql.exec(`DELETE FROM chunks WHERE key = ?`, key);
    const buffer = new Uint8Array(CHUNK);
    let filled = 0;
    let index = 0;
    let size = 0;

    const flush = () => {
      if (!filled) return;
      this.sql.exec(`INSERT INTO chunks (key, idx, data) VALUES (?, ?, ?)`, key, index, buffer.slice(0, filled).buffer);
      index += 1;
      filled = 0;
    };
    const feed = (bytes) => {
      let offset = 0;
      while (offset < bytes.length) {
        const take = Math.min(CHUNK - filled, bytes.length - offset);
        buffer.set(bytes.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        size += take;
        if (filled === CHUNK) flush();
      }
    };

    try {
      if (body && typeof body.getReader === 'function') {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          feed(toBytes(value));
        }
      } else if (body) {
        feed(toBytes(body));
      }
      flush();
    } catch (error) {
      this.sql.exec(`DELETE FROM chunks WHERE key = ?`, key);
      throw error;
    }
    return { size };
  }

  async get(key, options) {
    const total = this.sql.exec(`SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM chunks WHERE key = ?`, key).toArray()[0].n;
    if (!total) return null;

    const start = options && options.range ? options.range.offset : 0;
    const end = Math.min(total, options && options.range ? options.range.offset + options.range.length : total);
    let position = start;
    const sql = this.sql;

    const body = new ReadableStream({
      pull(controller) {
        if (position >= end) {
          controller.close();
          return;
        }
        const index = Math.floor(position / CHUNK);
        const row = sql.exec(`SELECT data FROM chunks WHERE key = ? AND idx = ?`, key, index).toArray()[0];
        if (!row) {
          controller.error(new Error('A stored file is missing a piece.'));
          return;
        }
        const bytes = toBytes(row.data);
        const from = position - index * CHUNK;
        const to = Math.min(bytes.length, from + (end - position));
        controller.enqueue(bytes.slice(from, to));
        position += to - from;
      },
    });
    return { body, size: end - start };
  }

  async delete(keys) {
    for (const key of [].concat(keys)) this.sql.exec(`DELETE FROM chunks WHERE key = ?`, key);
  }

  async deletePrefix(prefix) {
    this.sql.exec(`DELETE FROM chunks WHERE substr(key, 1, ?) = ?`, prefix.length, prefix);
  }
}

class R2Store {
  constructor(bucket) {
    this.bucket = bucket;
    this.name = 'r2';
  }

  put(key, body, options) {
    return this.bucket.put(key, body, options);
  }

  get(key, options) {
    return this.bucket.get(key, options);
  }

  delete(keys) {
    return this.bucket.delete(keys);
  }

  async deletePrefix(prefix) {
    let cursor;
    do {
      const listing = await this.bucket.list({ prefix, cursor, limit: 500 });
      const keys = listing.objects.map((object) => object.key);
      if (keys.length) await this.bucket.delete(keys);
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);
  }
}

/* ------------------------------------------------------------------ */
/* The hub                                                             */
/* ------------------------------------------------------------------ */

export class HubCore {
  // options.verify(token) asks Deluxe Main whose a key is; the Worker passes
  // one that asks the Main Durable Object in the same Worker.
  constructor(sql, env, options = {}) {
    this.sql = sql;
    this.env = env || {};
    this.failures = new Map();
    this.verified = new Map();
    this.verifyCall = options.verify || null;
    this.store = null;
    for (const statement of SCHEMA) this.sql.exec(statement);
    try {
      this.sql.exec(`ALTER TABLE blobs ADD COLUMN name TEXT`);
    } catch (error) {
      /* already there */
    }
    this.store = this.env.FILES ? new R2Store(this.env.FILES) : new SqlStore(this.sql);
    this.routes = [];
    this.defineRoutes();
  }

  /* ---------------- storage helpers ---------------- */

  all(query, ...params) {
    return this.sql.exec(query, ...params).toArray();
  }

  one(query, ...params) {
    return this.all(query, ...params)[0] || null;
  }

  run(query, ...params) {
    this.sql.exec(query, ...params);
  }

  get files() {
    return this.store;
  }

  get maxUpload() {
    return Number(this.env.MAX_UPLOAD_BYTES) > 0 ? Number(this.env.MAX_UPLOAD_BYTES) : 100 * 1024 * 1024;
  }

  blobKey(accountId, blobId) {
    if (!ID_PATTERN.test(String(accountId || '')) || !ID_PATTERN.test(String(blobId || ''))) return null;
    return `b/${accountId}/${blobId}`;
  }

  async deleteBlobPrefix(prefix) {
    await this.files.deletePrefix(prefix);
  }

  /* ---------------- old accounts, waiting to move to Deluxe Main ---------------- */

  publicAccount(account) {
    return { id: account.id, name: account.name, salt: account.salt };
  }

  accountById(id) {
    if (!ID_PATTERN.test(String(id || ''))) return null;
    return this.one(`SELECT * FROM accounts WHERE id = ?`, id);
  }

  accountByName(name) {
    const clean = String(name || '').trim().toLowerCase();
    if (!clean) return null;
    return this.one(`SELECT * FROM accounts WHERE name_lc = ?`, clean);
  }

  // A name nobody owns still gets a plausible looking record, so asking for it
  // cannot be used to find out who has an account here: the sign-in that
  // follows simply fails.
  async fakeAccount(name) {
    let secret = this.env.DELUXE_FAKE_SECRET || '';
    if (!secret) {
      const row = this.one(`SELECT value FROM meta WHERE key = 'fake-secret'`);
      if (row) secret = row.value;
      else {
        secret = randomToken(24);
        this.run(`INSERT OR IGNORE INTO meta (key, value) VALUES ('fake-secret', ?)`, secret);
      }
    }
    const clean = String(name || '').trim().slice(0, 24);
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(clean.toLowerCase())));
    return { id: `u_unknown_${digest.slice(0, 16)}`, name: clean, salt: digest.slice(0, 32) };
  }

  // An old account hands itself to Deluxe Main: the password hash must match.
  // The account row goes; its files, and its old file list (until the page
  // has moved it to Deluxe Main), stay under the same id.
  claimLegacy(name, hash) {
    const account = this.accountByName(name);
    if (!account || !safeEqual(account.hash, String(hash || ''))) return null;
    this.run(`DELETE FROM accounts WHERE id = ?`, account.id);
    this.run(`DELETE FROM sessions WHERE user_id = ?`, account.id);
    this.run(`DELETE FROM link_codes WHERE account_id = ?`, account.id);
    return { id: account.id, name: account.name, salt: account.salt };
  }

  /* Repeated wrong passwords for one name are slowed down. */
  tooManyFailures(key) {
    const entry = this.failures.get(key);
    return !!entry && entry.count >= 8 && entry.until > Date.now();
  }

  noteFailure(key) {
    const now = Date.now();
    const entry = this.failures.get(key);
    if (!entry || entry.until <= now) this.failures.set(key, { count: 1, until: now + 10 * 60 * 1000 });
    else entry.count += 1;
    if (this.failures.size > 2000) {
      for (const [name, value] of this.failures) if (value.until <= now) this.failures.delete(name);
    }
  }

  clearFailures(key) {
    this.failures.delete(key);
  }

  /* ---------------- nodes and settings ---------------- */

  listNodes(accountId) {
    return this.all(`SELECT json FROM nodes WHERE account_id = ?`, accountId).map((row) => JSON.parse(row.json));
  }

  /* ---------------- file contents ---------------- */

  blobInfo(accountId, blobId) {
    const row = this.one(`SELECT mime, size, updated_at, name FROM blobs WHERE account_id = ? AND id = ?`, accountId, blobId);
    const key = this.blobKey(accountId, blobId);
    if (!row || !key) return null;
    return { key, size: Number(row.size) || 0, mime: row.mime || 'application/octet-stream', updatedAt: row.updated_at, name: row.name || '' };
  }

  async saveBlob(accountId, blobId, request, mime, name) {
    const key = this.blobKey(accountId, blobId);
    if (!key) throw requestError('That file id is not valid.', 400);

    const cleanMime = String(mime || 'application/octet-stream').slice(0, 120);
    const declared = Number(request.headers.get('content-length') || 0);
    let object;

    if (declared > 0 && request.body) {
      object = await this.files.put(key, request.body, { httpMetadata: { contentType: cleanMime } });
    } else {
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > this.maxUpload) throw requestError('That file is too large for this server.', 413);
      object = await this.files.put(key, buffer, { httpMetadata: { contentType: cleanMime } });
    }

    const size = Number(object && object.size) || 0;
    this.run(
      `INSERT INTO blobs (account_id, id, mime, size, updated_at, name) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, id) DO UPDATE SET mime = excluded.mime, size = excluded.size,
         updated_at = excluded.updated_at, name = excluded.name`,
      accountId,
      blobId,
      cleanMime,
      size,
      Date.now(),
      String(name || '').slice(0, 200) || null
    );
    return size;
  }

  async deleteBlob(accountId, blobId) {
    const key = this.blobKey(accountId, blobId);
    if (!key) return false;
    await this.files.delete(key);
    this.run(`DELETE FROM blobs WHERE account_id = ? AND id = ?`, accountId, blobId);
    this.revokeShare(accountId, blobId);
    return true;
  }

  async clearAccountData(accountId) {
    this.run(`DELETE FROM nodes WHERE account_id = ?`, accountId);
    this.run(`DELETE FROM settings WHERE account_id = ?`, accountId);
    this.run(`DELETE FROM blobs WHERE account_id = ?`, accountId);
    this.run(`DELETE FROM shares WHERE account_id = ?`, accountId);
    await this.deleteBlobPrefix(`b/${accountId}/`);
  }

  async streamBlob(request, info, name, attachment) {
    const filename = String(name || 'file');
    const disposition = `${attachment ? 'attachment' : 'inline'}; filename="${asciiFilename(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
    const size = info.size;
    const base = {
      'Content-Type': info.mime || 'application/octet-stream',
      'Content-Disposition': disposition,
      'Cache-Control': 'private, max-age=0, must-revalidate',
      'Accept-Ranges': 'bytes',
    };

    const range = request.headers.get('range') ? parseRange(request.headers.get('range'), size) : null;
    if (range && range.invalid) {
      return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' } });
    }

    let status = 200;
    const headers = { ...base, 'Content-Length': String(size) };
    let options;

    if (range) {
      status = 206;
      headers['Content-Length'] = String(range.end - range.start + 1);
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
      options = { range: { offset: range.start, length: range.end - range.start + 1 } };
    }

    if (request.method === 'HEAD' || size === 0) return new Response(null, { status, headers });

    const object = await this.files.get(info.key, options);
    if (!object) return json(404, { error: 'That file has no stored data.' });
    return new Response(object.body, { status, headers });
  }

  /* ---------------- share links ---------------- */

  // A name given renames the link's file; otherwise a new link takes fallback.
  ensureShare(accountId, blobId, name, fallback = '') {
    const existing = this.one(`SELECT token FROM shares WHERE account_id = ? AND blob_id = ?`, accountId, blobId);
    if (existing) {
      if (name) this.run(`UPDATE shares SET name = ? WHERE token = ?`, String(name).slice(0, 200), existing.token);
      return existing.token;
    }
    const token = randomToken(16);
    this.run(
      `INSERT INTO shares (token, account_id, blob_id, name, created_at) VALUES (?, ?, ?, ?, ?)`,
      token,
      accountId,
      blobId,
      String(name || fallback || '').slice(0, 200),
      Date.now()
    );
    return token;
  }

  shareByToken(token) {
    if (!/^[0-9a-f]{8,64}$/i.test(String(token || ''))) return null;
    return this.one(`SELECT * FROM shares WHERE token = ?`, token);
  }

  revokeShare(accountId, blobId) {
    this.run(`DELETE FROM shares WHERE account_id = ? AND blob_id = ?`, accountId, blobId);
  }

  listShares(accountId) {
    return this.all(`SELECT * FROM shares WHERE account_id = ? ORDER BY created_at DESC`, accountId);
  }

  /* ---------------- who is asking: Deluxe Main decides ---------------- */

  // Asks Deluxe Main whose a key is. Answers are kept for a minute so a page
  // full of thumbnails does not ask a hundred times.
  async verify(token) {
    const clean = String(token || '');
    if (!clean || !this.verifyCall) return null;
    const now = Date.now();
    const cached = this.verified.get(clean);
    if (cached && cached.until > now) return cached.who;

    let who = null;
    try {
      const response = await this.verifyCall(clean);
      if (response && response.ok) {
        const data = await response.json();
        if (data && data.user && ID_PATTERN.test(String(data.user.id || ''))) {
          who = { userId: data.user.id, name: data.user.name, app: String(data.app || '') };
        }
      } else if (!response || response.status >= 500) {
        throw requestError('Deluxe Main could not be reached. Try again in a moment.', 503);
      }
    } catch (error) {
      if (error.status) throw error;
      throw requestError('Deluxe Main could not be reached. Try again in a moment.', 503);
    }

    if (this.verified.size > 5000) {
      for (const [key, value] of this.verified) if (value.until <= now) this.verified.delete(key);
    }
    this.verified.set(clean, { who, until: now + (who ? VERIFY_CACHE_MS : 5000) });
    return who;
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

  // Returns [session, null], or [null, an error response]. Deluxe Drive's own
  // page and Deluxe Main may do everything; Deluxe Docs may only read files;
  // Deluxe Convert may open and add files; Deluxe Transfer may only add files.
  async need(request) {
    const token = bearerToken(request);
    const who = token ? await this.verify(token) : null;
    if (!who) return [null, json(401, { error: 'Sign in with Deluxe Main again.', code: 'unauthorized' })];
    if (who.app === 'drive' || who.app === 'main') return [who, null];
    if (who.app === 'docs') {
      const path = new URL(request.url).pathname;
      const reading = request.method === 'GET' || request.method === 'HEAD';
      if (reading && /^\/api\/(db\/blobs\/[^/]+|auth\/me)$/.test(path)) return [who, null];
      return [null, json(403, { error: 'This connection can only read documents.', code: 'read-only' })];
    }
    // Deluxe Convert may upload new files (to save converted files here)...
    if (who.app === 'convert') {
      const path = new URL(request.url).pathname;
      if (request.method === 'PUT' && /^\/api\/db\/blobs\/[^/]+$/.test(path)) return [{ ...who, addOnly: true }, null];
      // ...and open files from the drive ("Add from Drive"), read only.
      if ((request.method === 'GET' || request.method === 'HEAD') && /^\/api\/db\/blobs\/[^/]+$/.test(path)) return [who, null];
      return [null, json(403, { error: 'Deluxe Convert can only open and add files.', code: 'add-only' })];
    }
    // Deluxe Transfer may only upload new files ("Save to Deluxe Drive").
    if (who.app === 'transfer') {
      const path = new URL(request.url).pathname;
      if (request.method === 'PUT' && /^\/api\/db\/blobs\/[^/]+$/.test(path)) return [{ ...who, addOnly: true }, null];
      return [null, json(403, { error: 'Deluxe Transfer can only add files.', code: 'add-only' })];
    }
    return [null, json(403, { error: 'This website cannot use Deluxe Drive.', code: 'forbidden' })];
  }

  defineRoutes() {
    const r = (method, pattern, handler) => this.route(method, pattern, handler);
    const origin = (url) => url.origin;
    const gone = (message) => () => json(410, { error: message, code: 'moved-to-deluxe-main' });
    const accountsMoved = 'Deluxe accounts are made and managed on Deluxe Main now.';

    r('GET', '/api/health', () =>
      json(200, {
        ok: true,
        name: SERVER_NAME,
        server: true,
        storage: 'server',
        files: this.store.name,
        version: 'worker 3',
        accounts: 'deluxe-main',
        // Deluxe Main's website (on Vercel), where people sign in.
        main: String(this.env.MAIN_SITE || 'https://deluxe-main.vercel.app').replace(/\/+$/, ''),
        limits: { uploadBytes: this.maxUpload },
      })
    );

    r('GET', '/api/auth/me', async ({ request }) => {
      const [who, denied] = await this.need(request);
      if (denied) return denied;
      return json(200, { user: { id: who.userId, name: who.name }, app: who.app });
    });

    // No account is ever made or changed here any more.
    r('POST', '/api/accounts', gone(accountsMoved));
    r('POST', '/api/auth/session', gone(accountsMoved));
    r('PATCH', '/api/accounts/:id', gone(accountsMoved));
    r('POST', '/api/accounts/:id/password', gone(accountsMoved));
    r('DELETE', '/api/accounts/:id', gone(accountsMoved));
    r('POST', '/api/link', gone('Deluxe Docs signs in with Deluxe Main now. No link ID is needed.'));
    r('POST', '/api/link/redeem', gone('Deluxe Docs signs in with Deluxe Main now. No link ID is needed.'));

    /* ---- old accounts moving to Deluxe Main (Deluxe Main calls these) ---- */

    // The salt of an old account, so Deluxe Main can check its password. Unknown
    // names get a steady fake one, as before.
    r('POST', '/api/accounts/find', async ({ request }) => {
      const body = await readJsonBody(request);
      const name = String(body.name || '').trim();
      if (!name) return json(400, { error: 'Type your account name.' });
      const account = this.accountByName(name);
      return json(200, account ? this.publicAccount(account) : await this.fakeAccount(name));
    });

    r('POST', '/api/legacy/exists', async ({ request }) => {
      const body = await readJsonBody(request);
      return json(200, { exists: !!this.accountByName(body.name) });
    });

    r('POST', '/api/legacy/claim', async ({ request }) => {
      const body = await readJsonBody(request);
      const key = `claim:${String(body.name || '').trim().toLowerCase()}`;
      if (this.tooManyFailures(key)) return json(429, { error: 'Too many wrong tries. Wait a few minutes.' });
      const moved = this.claimLegacy(body.name, body.hash);
      if (!moved) {
        this.noteFailure(key);
        return json(401, { error: 'That account did not match.', code: 'unauthorized' });
      }
      this.clearFailures(key);
      return json(200, moved);
    });

    // The old file list and settings of the signed-in account, for the page to
    // move into Deluxe Main once; then /done empties them here.
    r('GET', '/api/legacy/data', async ({ request }) => {
      const [who, denied] = await this.need(request);
      if (denied) return denied;
      const settings = this.all(`SELECT key, json FROM settings WHERE account_id = ?`, who.userId).map((row) => ({
        key: row.key,
        value: JSON.parse(row.json),
      }));
      return json(200, { nodes: this.listNodes(who.userId), settings });
    });

    r('POST', '/api/legacy/data/done', async ({ request }) => {
      const [who, denied] = await this.need(request);
      if (denied) return denied;
      this.run(`DELETE FROM nodes WHERE account_id = ?`, who.userId);
      this.run(`DELETE FROM settings WHERE account_id = ?`, who.userId);
      return json(200, { ok: true });
    });

    /* ---- file contents ---- */

    r('GET', '/api/db/blobs/:id', async ({ request, params }) => {
      const [who, denied] = await this.need(request);
      if (denied) return denied;
      const info = this.blobInfo(who.userId, params.id);
      if (!info) return json(404, { error: 'That file has no stored data.' });
      return this.streamBlob(request, info, info.name || params.id, false);
    });

    r('PUT', '/api/db/blobs/:id', async ({ request, params }) => {
      const [who, denied] = await this.need(request);
      if (denied) return denied;
      if (Number(request.headers.get('content-length') || 0) > this.maxUpload) {
        return json(413, { error: 'That file is too large for this server.' });
      }
      if (who.addOnly && this.blobInfo(who.userId, params.id)) {
        return json(409, { error: 'That file is already there.', code: 'exists' });
      }
      const mime = String(request.headers.get('x-deluxe-mime') || request.headers.get('content-type') || 'application/octet-stream');
      const name = decodeSegment(String(request.headers.get('x-deluxe-name') || ''));
      try {
        const size = await this.saveBlob(who.userId, params.id, request, mime, name);
        return json(201, { ok: true, id: params.id, size, mime });
      } catch (error) {
        return json(error.status || 400, { error: error.status ? error.message : 'That file could not be stored.' });
      }
    });

    // Deleting a file's contents also ends any share link to it.
    r('DELETE', '/api/db/blobs/:id', async ({ request, params }) => {
      const [who, denied] = await this.need(request);
      if (denied) return denied;
      await this.deleteBlob(who.userId, params.id);
      return json(200, { ok: true });
    });

    // Empties the account's files here (Deluxe Main calls this when an account is deleted).
    r('POST', '/api/db/clear', async ({ request }) => {
      const [who, denied] = await this.need(request);
      if (denied) return denied;
      await this.clearAccountData(who.userId);
      return json(200, { ok: true });
    });

    r('GET', '/api/db/usage', async ({ request }) => {
      const [who, denied] = await this.need(request);
      if (denied) return denied;
      const row = this.one(`SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM blobs WHERE account_id = ?`, who.userId);
      return json(200, { files: Number(row.files) || 0, bytes: Number(row.bytes) || 0 });
    });

    /* ---- share links ---- */

    r('POST', '/api/files/:id/share', async ({ request, params, url }) => {
      const [who, denied] = await this.need(request);
      if (denied) return denied;
      const info = this.blobInfo(who.userId, params.id);
      if (!info) return json(404, { error: 'That file is not here.' });
      const body = await readJsonBody(request);
      const token = this.ensureShare(who.userId, params.id, String(body.name || '').slice(0, 200), info.name || params.id);
      const name = this.shareByToken(token).name;
      return json(200, { token, path: `/s/${token}`, url: `${origin(url)}/s/${token}`, name });
    });

    r('DELETE', '/api/files/:id/share', async ({ request, params }) => {
      const [who, denied] = await this.need(request);
      if (denied) return denied;
      this.revokeShare(who.userId, params.id);
      return json(200, { ok: true });
    });

    r('GET', '/api/files/shares', async ({ request, url }) => {
      const [who, denied] = await this.need(request);
      if (denied) return denied;
      return json(200, {
        shares: this.listShares(who.userId).map((share) => ({
          token: share.token,
          name: share.name,
          fileId: share.blob_id,
          createdAt: share.created_at,
          path: `/s/${share.token}`,
          url: `${origin(url)}/s/${share.token}`,
        })),
      });
    });

    r('GET', '/api/shared/:token', ({ request, params }) => this.serveShared(request, params.token));
  }

  /* ---------------- public pieces ---------------- */

  async serveShared(request, token) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json(405, { error: 'Only reading is allowed here.' });
    }
    const share = this.shareByToken(token);
    if (!share) return text(404, 'Not found');
    const info = this.blobInfo(share.account_id, share.blob_id);
    if (!info) return text(404, 'Not found');
    return this.streamBlob(request, info, share.name || info.name || share.blob_id, false);
  }

  async handle(request) {
    try {
      const url = new URL(request.url);
      const segments = url.pathname.split('/').filter(Boolean).map(decodeSegment);

      if (url.pathname.startsWith('/api/')) {
        const match = this.matchRoute(request.method, segments);
        if (!match) return json(404, { error: 'There is nothing at that address.' });
        return await match.handler({ request, url, params: match.params });
      }
      if (url.pathname.startsWith('/s/')) return await this.serveShared(request, segments[1] || '');
      return text(404, 'Not found');
    } catch (error) {
      console.error('Request failed:', request.method, request.url, error);
      return json(error.status || 500, {
        error: error.status ? error.message : 'The drive could not answer that.',
      });
    }
  }
}

