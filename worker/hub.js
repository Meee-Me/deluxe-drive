// The Deluxe Drive server, for Cloudflare Workers.
//
// The drive's own pages (js/cloud.js) talk to this, and so does Deluxe Docs:
//   - accounts, file records and settings, share links, link ids and sessions
//     live in the Durable Object's SQLite database (one object, so writes
//     never race),
//   - file contents live in the same database in 1 MB pieces, or in R2 when a
//     bucket is bound as FILES.
//
// Deluxe Docs connects with a link id: a short code the signed-in drive makes,
// good for 60 seconds and for one use, that Docs trades for a read-only key.
//
// Nothing in here touches Node APIs. It takes a SQL handle and an env, so the
// same code runs in the Durable Object and in the local tests.


const SERVER_NAME = 'Deluxe Drive';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;
const HEX_PATTERN = /^[0-9a-fA-F]{16,128}$/;
const SETTINGS_KEY = /^[A-Za-z0-9_.-]{1,60}$/;
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const LINK_TTL_SECONDS = 60;
const DOCS_SESSION_SECONDS = 30 * 24 * 60 * 60;
const LINK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
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
  constructor(sql, env) {
    this.sql = sql;
    this.env = env || {};
    this.failures = new Map();
    this.store = null;
    for (const statement of SCHEMA) this.sql.exec(statement);
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

  /* ---------------- accounts ---------------- */

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

  createAccount({ name, salt, hash }) {
    const cleanName = String(name || '').trim().slice(0, 24);
    const cleanSalt = String(salt || '');
    const cleanHash = String(hash || '');

    if (!cleanName) throw requestError('Type a name for the account.', 400);
    if (!HEX_PATTERN.test(cleanSalt) || !HEX_PATTERN.test(cleanHash)) {
      throw requestError('That account record is not valid.', 400);
    }
    if (this.accountByName(cleanName)) throw requestError('That name is already used on this drive.', 409, 'name-taken');

    const now = Date.now();
    const id = `u_${now.toString(36)}_${randomToken(3)}`;
    this.run(
      `INSERT INTO accounts (id, name, name_lc, salt, hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      cleanName,
      cleanName.toLowerCase(),
      cleanSalt,
      cleanHash,
      now,
      now
    );
    return this.accountById(id);
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

  renameAccount(id, name) {
    const clean = String(name || '').trim().slice(0, 24);
    if (!clean) throw requestError('Type a name for the account.', 400);
    const account = this.accountById(id);
    if (!account) throw requestError('That account is not here.', 404);
    const other = this.accountByName(clean);
    if (other && other.id !== id) throw requestError('That name is already used on this drive.', 409);
    this.run(`UPDATE accounts SET name = ?, name_lc = ?, updated_at = ? WHERE id = ?`, clean, clean.toLowerCase(), Date.now(), id);
    return this.accountById(id);
  }

  setAccountPassword(id, salt, hash) {
    const cleanSalt = String(salt || '');
    const cleanHash = String(hash || '');
    if (!HEX_PATTERN.test(cleanSalt) || !HEX_PATTERN.test(cleanHash)) {
      throw requestError('That account record is not valid.', 400);
    }
    if (!this.accountById(id)) throw requestError('That account is not found.', 404);
    this.run(`UPDATE accounts SET salt = ?, hash = ?, updated_at = ? WHERE id = ?`, cleanSalt, cleanHash, Date.now(), id);
  }

  async deleteAccount(id) {
    if (!this.accountById(id)) return false;
    this.run(`DELETE FROM accounts WHERE id = ?`, id);
    for (const table of ['nodes', 'settings', 'blobs']) this.run(`DELETE FROM ${table} WHERE account_id = ?`, id);
    this.run(`DELETE FROM shares WHERE account_id = ?`, id);
    this.run(`DELETE FROM link_codes WHERE account_id = ?`, id);
    this.run(`DELETE FROM sessions WHERE user_id = ?`, id);
    await this.deleteBlobPrefix(`b/${id}/`);
    return true;
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

  getNode(accountId, nodeId) {
    if (!ID_PATTERN.test(String(nodeId || ''))) return null;
    const row = this.one(`SELECT json FROM nodes WHERE account_id = ? AND id = ?`, accountId, nodeId);
    return row ? JSON.parse(row.json) : null;
  }

  putNode(accountId, node) {
    if (!node || typeof node !== 'object') throw requestError('That file record is not valid.', 400);
    if (!ID_PATTERN.test(String(node.id || ''))) throw requestError('That file id is not valid.', 400);
    this.run(
      `INSERT INTO nodes (account_id, id, json) VALUES (?, ?, ?)
       ON CONFLICT (account_id, id) DO UPDATE SET json = excluded.json`,
      accountId,
      node.id,
      JSON.stringify(node)
    );
  }

  putNodes(accountId, nodes) {
    if (!Array.isArray(nodes)) throw requestError('That list of files is not valid.', 400);
    for (const node of nodes) {
      if (!node || typeof node !== 'object' || !ID_PATTERN.test(String(node.id || ''))) {
        throw requestError('One of those file records is not valid.', 400);
      }
    }
    for (const node of nodes) this.putNode(accountId, node);
    return nodes.length;
  }

  deleteNode(accountId, nodeId) {
    if (!ID_PATTERN.test(String(nodeId || ''))) return false;
    this.run(`DELETE FROM nodes WHERE account_id = ? AND id = ?`, accountId, nodeId);
    return true;
  }

  getSetting(accountId, key) {
    const row = this.one(`SELECT json FROM settings WHERE account_id = ? AND key = ?`, accountId, key);
    return row ? JSON.parse(row.json) : undefined;
  }

  putSetting(accountId, key, value) {
    this.run(
      `INSERT INTO settings (account_id, key, json) VALUES (?, ?, ?)
       ON CONFLICT (account_id, key) DO UPDATE SET json = excluded.json`,
      accountId,
      key,
      JSON.stringify(value === undefined ? null : value)
    );
  }

  deleteSetting(accountId, key) {
    this.run(`DELETE FROM settings WHERE account_id = ? AND key = ?`, accountId, key);
  }

  /* ---------------- file contents ---------------- */

  blobInfo(accountId, blobId) {
    const row = this.one(`SELECT mime, size, updated_at FROM blobs WHERE account_id = ? AND id = ?`, accountId, blobId);
    const key = this.blobKey(accountId, blobId);
    if (!row || !key) return null;
    return { key, size: Number(row.size) || 0, mime: row.mime || 'application/octet-stream', updatedAt: row.updated_at };
  }

  async saveBlob(accountId, blobId, request, mime) {
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
      `INSERT INTO blobs (account_id, id, mime, size, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (account_id, id) DO UPDATE SET mime = excluded.mime, size = excluded.size, updated_at = excluded.updated_at`,
      accountId,
      blobId,
      cleanMime,
      size,
      Date.now()
    );
    return size;
  }

  async deleteBlob(accountId, blobId) {
    const key = this.blobKey(accountId, blobId);
    if (!key) return false;
    await this.files.delete(key);
    this.run(`DELETE FROM blobs WHERE account_id = ? AND id = ?`, accountId, blobId);
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

  ensureShare(accountId, blobId, name) {
    const existing = this.one(`SELECT token FROM shares WHERE account_id = ? AND blob_id = ?`, accountId, blobId);
    if (existing) return existing.token;
    const token = randomToken(16);
    this.run(
      `INSERT INTO shares (token, account_id, blob_id, name, created_at) VALUES (?, ?, ?, ?, ?)`,
      token,
      accountId,
      blobId,
      String(name || '').slice(0, 200),
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

  /* ---------------- link ids for Deluxe Docs ---------------- */

  static formatLinkId(raw) {
    return raw.replace(/(.{4})(?=.)/g, '$1-');
  }

  static cleanLinkId(value) {
    return String(value || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  async hashLinkId(clean) {
    return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(`deluxe-link:${clean}`)));
  }

  // A new id each time, letters and digits only (no 0, O, 1 or I to misread),
  // 12 characters. Making one ends any earlier id of the same account.
  async createLinkId(accountId) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    let raw = '';
    for (const byte of bytes) raw += LINK_ALPHABET[byte % LINK_ALPHABET.length];
    const now = Date.now();
    this.run(`DELETE FROM link_codes WHERE account_id = ? OR expires_at <= ?`, accountId, now);
    this.run(
      `INSERT INTO link_codes (code_hash, account_id, expires_at) VALUES (?, ?, ?)`,
      await this.hashLinkId(raw),
      accountId,
      now + LINK_TTL_SECONDS * 1000
    );
    return { linkId: HubCore.formatLinkId(raw), expiresIn: LINK_TTL_SECONDS };
  }

  // Finds the account a link id belongs to and uses the id up.
  async takeLinkId(value) {
    const clean = HubCore.cleanLinkId(value);
    if (clean.length !== 12) return null;
    const hash = await this.hashLinkId(clean);
    const row = this.one(`SELECT account_id, expires_at FROM link_codes WHERE code_hash = ?`, hash);
    if (!row) return null;
    this.run(`DELETE FROM link_codes WHERE code_hash = ?`, hash);
    if (row.expires_at <= Date.now()) return null;
    return this.accountById(row.account_id);
  }

  /* ---------------- sessions ---------------- */

  createSession(userId, options = {}) {
    const ttlSeconds = Number(options.ttlSeconds) > 0 ? Number(options.ttlSeconds) : SESSION_TTL_SECONDS;
    const now = Date.now();
    this.run(`DELETE FROM sessions WHERE expires_at <= ?`, now);
    const token = randomToken(32);
    this.run(
      `INSERT INTO sessions (token, user_id, client_id, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
      token,
      userId,
      options.clientId || null,
      options.scope || 'drive',
      now,
      now + ttlSeconds * 1000
    );
    return { token, expiresIn: ttlSeconds };
  }

  sessionFor(token) {
    const clean = String(token || '');
    if (!clean) return null;
    const row = this.one(`SELECT * FROM sessions WHERE token = ?`, clean);
    if (!row) return null;
    if (row.expires_at <= Date.now()) {
      this.run(`DELETE FROM sessions WHERE token = ?`, clean);
      return null;
    }
    return { token: row.token, userId: row.user_id, clientId: row.client_id, scope: row.scope };
  }

  dropSession(token) {
    this.run(`DELETE FROM sessions WHERE token = ?`, String(token || ''));
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

  // Returns [session, null], or [null, a 401 response].
  need(request) {
    const token = bearerToken(request);
    const session = token ? this.sessionFor(token) : null;
    if (!session) return [null, json(401, { error: 'Sign in to Deluxe Drive again.', code: 'unauthorized' })];

    // The key Deluxe Docs gets for a link id may read the file list and the
    // files, and nothing else.
    if (session.clientId) {
      const path = new URL(request.url).pathname;
      const reading = request.method === 'GET' || request.method === 'HEAD';
      if (!reading || !/^\/api\/(db\/(nodes|blobs)(\/|$)|auth\/me$)/.test(path)) {
        return [null, json(403, { error: 'This connection can only read documents.', code: 'read-only' })];
      }
    }
    return [session, null];
  }

  own(session, id) {
    return session.userId === id ? null : json(403, { error: 'That is not your account.' });
  }

  defineRoutes() {
    const r = (method, pattern, handler) => this.route(method, pattern, handler);
    const origin = (url) => url.origin;

    r('GET', '/api/health', () =>
      json(200, {
        ok: true,
        name: SERVER_NAME,
        server: true,
        storage: 'server',
        files: this.store.name,
        version: 'worker 2',
        linkIds: { create: '/api/link', redeem: '/api/link/redeem', seconds: LINK_TTL_SECONDS },
        limits: { uploadBytes: this.maxUpload },
      })
    );

    r('POST', '/api/auth/session', async ({ request }) => {
      const body = await readJsonBody(request);
      const userId = String(body.userId || '');
      if (this.tooManyFailures(`session:${userId}`)) {
        return json(429, { error: 'Too many wrong tries. Wait a few minutes and try again.', code: 'rate-limited' });
      }
      const account = this.accountById(userId);
      if (!account || !safeEqual(account.hash, String(body.hash || ''))) {
        this.noteFailure(`session:${userId}`);
        return json(401, { error: 'That account did not match.', code: 'unauthorized' });
      }
      this.clearFailures(`session:${userId}`);
      const session = this.createSession(account.id, { scope: 'drive', ttlSeconds: SESSION_TTL_SECONDS });
      return json(200, { token: session.token, expiresIn: session.expiresIn, user: { id: account.id, name: account.name } });
    });

    r('GET', '/api/auth/me', ({ request }) => {
      const [session, denied] = this.need(request);
      if (denied) return denied;
      const account = this.accountById(session.userId);
      if (!account) return json(401, { error: 'Sign in to Deluxe Drive again.', code: 'unauthorized' });
      return json(200, { user: { id: account.id, name: account.name } });
    });

    r('POST', '/api/accounts', async ({ request }) => {
      const body = await readJsonBody(request);
      let account;
      try {
        account = this.createAccount({ name: body.name, salt: body.salt, hash: body.hash });
      } catch (error) {
        const status = error.status || 500;
        return json(status, {
          error: error.status ? error.message : 'That account could not be made.',
          code: error.code || (status === 409 ? 'name-taken' : 'create-failed'),
        });
      }
      const session = this.createSession(account.id, { scope: 'drive', ttlSeconds: SESSION_TTL_SECONDS });
      return json(201, { token: session.token, expiresIn: session.expiresIn, user: { id: account.id, name: account.name } });
    });

    r('POST', '/api/accounts/find', async ({ request }) => {
      const body = await readJsonBody(request);
      const name = String(body.name || '').trim();
      if (!name) return json(400, { error: 'Type your account name.' });
      const account = this.accountByName(name);
      return json(200, account ? this.publicAccount(account) : await this.fakeAccount(name));
    });

    r('GET', '/api/accounts/:id', ({ params }) => {
      const account = this.accountById(params.id);
      if (!account) return json(404, { error: 'That account is not here.' });
      return json(200, this.publicAccount(account));
    });

    r('PATCH', '/api/accounts/:id', async ({ request, params }) => {
      const [session, denied] = this.need(request);
      if (denied) return denied;
      const notYours = this.own(session, params.id);
      if (notYours) return notYours;
      const body = await readJsonBody(request);
      try {
        const account = this.renameAccount(session.userId, body.name);
        return json(200, { user: { id: account.id, name: account.name } });
      } catch (error) {
        return json(error.status || 500, { error: error.message || 'That name could not be saved.' });
      }
    });

    r('POST', '/api/accounts/:id/password', async ({ request, params }) => {
      const [session, denied] = this.need(request);
      if (denied) return denied;
      const notYours = this.own(session, params.id);
      if (notYours) return notYours;
      const body = await readJsonBody(request);
      const account = this.accountById(session.userId);
      if (!account || !safeEqual(account.hash, String(body.currentHash || ''))) {
        return json(401, { error: 'That password is not correct.', code: 'unauthorized' });
      }
      try {
        this.setAccountPassword(session.userId, body.salt, body.hash);
        return json(200, { ok: true });
      } catch (error) {
        return json(error.status || 500, { error: error.message || 'That password could not be saved.' });
      }
    });

    r('DELETE', '/api/accounts/:id', async ({ request, params }) => {
      const [session, denied] = this.need(request);
      if (denied) return denied;
      const notYours = this.own(session, params.id);
      if (notYours) return notYours;
      const removed = await this.deleteAccount(session.userId);
      if (!removed) return json(404, { error: 'That account is not here.' });
      return json(200, { ok: true });
    });

    r('GET', '/api/db/nodes', ({ request }) => {
      const [session, denied] = this.need(request);
      if (denied) return denied;
      return json(200, { nodes: this.listNodes(session.userId) });
    });

    r('GET', '/api/db/nodes/:id', ({ request, params }) => {
      const [session, denied] = this.need(request);
      if (denied) return denied;
      const node = this.getNode(session.userId, params.id);
      return node ? json(200, { node }) : json(404, { error: 'That file is not here.' });
    });

    r('POST', '/api/db/nodes', async ({ request }) => {
      const [session, denied] = this.need(request);
      if (denied) return denied;
      const body = await readJsonBody(request);
      try {
        return json(200, { ok: true, count: this.putNodes(session.userId, body.nodes) });
      } catch (error) {
        return json(error.status || 400, { error: error.message || 'Those files could not be saved.' });
      }
    });

    r('PUT', '/api/db/nodes/:id', async ({ request, params }) => {
      const [session, denied] = this.need(request);
      if (denied) return denied;
      const body = await readJsonBody(request);
      const node = { ...body, id: params.id };
      try {
        this.putNode(session.userId, node);
        return json(200, { ok: true, id: node.id });
      } catch (error) {
        return json(error.status || 400, { error: error.message || 'That file could not be saved.' });
      }
    });

    r('DELETE', '/api/db/nodes/:id', async ({ request, params }) => {
      const [session, denied] = this.need(request);
      if (denied) return denied;
      // Blobs and share links are keyed by the node id, so deleting the file
      // also ends its stored data and any link that still pointed at it.
      this.deleteNode(session.userId, params.id);
      await this.deleteBlob(session.userId, params.id);
      this.revokeShare(session.userId, params.id);
      return json(200, { ok: true });
    });

    r('GET', '/api/db/blobs/:id', async ({ request, params }) => {
      const [session, denied] = this.need(request);
      if (denied) return denied;
      const info = this.blobInfo(session.userId, params.id);
      if (!info) return json(404, { error: 'That file has no stored data.' });
      const node = this.getNode(session.userId, params.id);
      return this.streamBlob(request, info, node ? node.name : params.id, false);
    });

    r('PUT', '/api/db/blobs/:id', async ({ request, params }) => {
      const [session, denied] = this.need(request);
      if (denied) return denied;
      if (Number(request.headers.get('content-length') || 0) > this.maxUpload) {
        return json(413, { error: 'That file is too large for this server.' });
      }
      const mime = String(request.headers.get('x-deluxe-mime') || request.headers.get('content-type') || 'application/octet-stream');
      try {
        const size = await this.saveBlob(session.userId, params.id, request, mime);
        return json(201, { ok: true, id: params.id, size, mime });
      } catch (error) {
        return json(error.status || 400, { error: error.status ? error.message : 'That file could not be stored.' });
      }
    });

    r('DELETE', '/api/db/blobs/:id', async ({ request, params }) => {
      const [session, denied] = this.need(request);
      if (denied) return denied;
      await this.deleteBlob(session.userId, params.id);
      return json(200, { ok: true });
    });

    r('GET', '/api/db/settings/:key', ({ request, params }) => {
      const [session, denied] = this.need(request);
      if (denied) return denied;
      if (!SETTINGS_KEY.test(params.key)) return json(400, { error: 'That setting name is not valid.' });
      const value = this.getSetting(session.userId, params.key);
      return value === undefined ? json(404, { error: 'That setting is not set.' }) : json(200, { key: params.key, value });
    });

    r('PUT', '/api/db/settings/:key', async ({ request, params }) => {
      const [session, denied] = this.need(request);
      if (denied) return denied;
      if (!SETTINGS_KEY.test(params.key)) return json(400, { error: 'That setting key is not valid.' });
      const body = await readJsonBody(request);
      this.putSetting(session.userId, params.key, body.value);
      return json(200, { ok: true, key: params.key });
    });

    r('DELETE', '/api/db/settings/:key', ({ request, params }) => {
      const [session, denied] = this.need(request);
      if (denied) return denied;
      this.deleteSetting(session.userId, params.key);
      return json(200, { ok: true });
    });

    r('POST', '/api/db/clear', async ({ request }) => {
      const [session, denied] = this.need(request);
      if (denied) return denied;
      await this.clearAccountData(session.userId);
      return json(200, { ok: true });
    });

    r('POST', '/api/files/:id/share', ({ request, params, url }) => {
      const [session, denied] = this.need(request);
      if (denied) return denied;
      const node = this.getNode(session.userId, params.id);
      if (!node) return json(404, { error: 'That file is not here.' });
      if (node.type !== 'file') return json(400, { error: 'Folders cannot be shared on their own.' });
      const token = this.ensureShare(session.userId, node.id, node.name);
      return json(200, { token, path: `/s/${token}`, url: `${origin(url)}/s/${token}`, name: node.name });
    });

    r('DELETE', '/api/files/:id/share', ({ request, params }) => {
      const [session, denied] = this.need(request);
      if (denied) return denied;
      this.revokeShare(session.userId, params.id);
      return json(200, { ok: true });
    });

    r('GET', '/api/files/shares', ({ request, url }) => {
      const [session, denied] = this.need(request);
      if (denied) return denied;
      return json(200, {
        shares: this.listShares(session.userId).map((share) => ({
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

    r('POST', '/api/link', async ({ request }) => {
      const [session, denied] = this.need(request);
      if (denied) return denied;
      if (session.clientId) return json(403, { error: 'Make a link id from Deluxe Drive itself.' });
      return json(201, await this.createLinkId(session.userId));
    });

    // Deluxe Docs sends the pasted id here. The account is found from the id
    // alone; what comes back is a key that can only read.
    r('POST', '/api/link/redeem', async ({ request }) => {
      const who = `redeem:${request.headers.get('cf-connecting-ip') || 'unknown'}`;
      if (this.tooManyFailures(who)) {
        return json(429, { error: 'Too many wrong link ids. Wait a few minutes and try again.', code: 'rate-limited' });
      }
      const body = await readJsonBody(request);
      const account = await this.takeLinkId(body.linkId);
      if (!account) {
        this.noteFailure(who);
        return json(404, {
          error: 'That link id is not right or has run out. Make a new one in Deluxe Drive and paste it within 60 seconds.',
          code: 'link-not-found',
        });
      }
      const session = this.createSession(account.id, {
        clientId: 'deluxe-docs',
        scope: 'drive.read',
        ttlSeconds: DOCS_SESSION_SECONDS,
      });
      return json(200, {
        token: session.token,
        expiresIn: session.expiresIn,
        user: { id: account.id, name: account.name },
        driveName: SERVER_NAME,
      });
    });

    // Disconnecting Deluxe Docs ends its key.
    r('DELETE', '/api/link/session', ({ request }) => {
      const token = bearerToken(request);
      if (token) this.dropSession(token);
      return json(200, { ok: true });
    });
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
    return this.streamBlob(request, info, share.name || share.blob_id, false);
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

export { SESSION_TTL_SECONDS, LINK_TTL_SECONDS };
