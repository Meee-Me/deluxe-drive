// The Deluxe Drive server, for Cloudflare Workers.
//
// The drive's own pages (js/cloud.js) talk to this, and so does Deluxe Docs:
//   - accounts, file records and settings, share links, link ids and sessions
//     live in the Durable Object's SQLite database (one object, so writes
//     never race),
//   - file contents live in the same database in 1 MB pieces, or in R2 when a
//     bucket is bound as FILES.
//
// Deluxe Docs and Deluxe Convert connect with a link id: a short code the
// signed-in drive makes for one of them, good for 60 seconds and for one use.
// Docs trades it for a read-only key; Convert for a key that can only add
// converted files to the drive (POST /api/import).
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
const APP_SESSION_SECONDS = 30 * 24 * 60 * 60;
// The other Deluxe sites that can connect with a link id, and what their key
// may do. Docs reads; Convert only adds files.
const LINK_APPS = {
  'deluxe-docs': { name: 'Deluxe Docs', scope: 'drive.read' },
  'deluxe-convert': { name: 'Deluxe Convert', scope: 'drive.import' },
};
const DEFAULT_LINK_APP = 'deluxe-docs';
const IMPORT_FOLDER = 'Deluxe Convert';
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
     code_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires_at INTEGER NOT NULL, client TEXT)`,
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
// The size of each piece when a file is sent in several requests.
const PART = 4 * CHUNK;

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
    this.parts = true;
  }

  async rows(query, ...params) {
    return (await this.sql.exec(query, ...params)).toArray();
  }

  // Writes body as 1 MB rows starting at row `first`. A file sent in several
  // requests (a Vercel Function takes about 4.5 MB per request) is written
  // piece by piece: every piece but the last is a whole number of rows.
  async putAt(key, first, body) {
    const buffer = new Uint8Array(CHUNK);
    let filled = 0;
    let index = first;
    let size = 0;

    const flush = async () => {
      if (!filled) return;
      const data = buffer.slice(0, filled).buffer;
      const at = index;
      index += 1;
      filled = 0;
      await this.sql.exec(`INSERT INTO chunks (key, idx, data) VALUES (?, ?, ?)`, key, at, data);
    };
    const feed = async (bytes) => {
      let offset = 0;
      while (offset < bytes.length) {
        const take = Math.min(CHUNK - filled, bytes.length - offset);
        buffer.set(bytes.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        size += take;
        if (filled === CHUNK) await flush();
      }
    };

    await this.sql.exec(`DELETE FROM chunks WHERE key = ? AND idx >= ?`, key, first);
    try {
      if (body && typeof body.getReader === 'function') {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await feed(toBytes(value));
        }
      } else if (body) {
        await feed(toBytes(body));
      }
      await flush();
    } catch (error) {
      await this.sql.exec(`DELETE FROM chunks WHERE key = ? AND idx >= ?`, key, first);
      throw error;
    }
    return { size, rows: index - first };
  }

  async put(key, body) {
    await this.sql.exec(`DELETE FROM chunks WHERE key = ?`, key);
    return this.putAt(key, 0, body);
  }

  async total(key) {
    const row = (await this.rows(`SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM chunks WHERE key = ?`, key))[0];
    return Number(row && row.n) || 0;
  }

  async get(key, options) {
    const total = await this.total(key);
    if (!total) return null;

    const start = options && options.range ? options.range.offset : 0;
    const end = Math.min(total, options && options.range ? options.range.offset + options.range.length : total);
    let position = start;
    const store = this;

    const body = new ReadableStream({
      async pull(controller) {
        if (position >= end) {
          controller.close();
          return;
        }
        const index = Math.floor(position / CHUNK);
        const row = (await store.rows(`SELECT data FROM chunks WHERE key = ? AND idx = ?`, key, index))[0];
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
    for (const key of [].concat(keys)) await this.sql.exec(`DELETE FROM chunks WHERE key = ?`, key);
  }

  async deletePrefix(prefix) {
    await this.sql.exec(`DELETE FROM chunks WHERE substr(key, 1, ?) = ?`, prefix.length, prefix);
  }
}

class R2Store {
  constructor(bucket) {
    this.bucket = bucket;
    this.name = 'r2';
    this.parts = false;
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
    this.readyPromise = null;
    // A host can bring its own file store (Vercel Blob, see api/_blob.mjs);
    // otherwise R2 when bound, else the database itself.
    this.store = this.env.FILE_STORE || (this.env.FILES ? new R2Store(this.env.FILES) : new SqlStore(this.sql));
    this.routes = [];
    this.defineRoutes();
  }

  // Makes the tables on first use. Durable Objects answer at once; Postgres
  // (on Vercel) is asked over the network, so this is awaited once per instance.
  ready() {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        for (const statement of SCHEMA) await this.sql.exec(statement);
        // Databases made before Deluxe Convert could connect have no client column.
        try {
          await this.sql.exec(`ALTER TABLE link_codes ADD COLUMN client TEXT`);
        } catch (error) {
          /* already there */
        }
      })().catch((error) => {
        this.readyPromise = null;
        throw error;
      });
    }
    return this.readyPromise;
  }

  /* ---------------- storage helpers ---------------- */

  async all(query, ...params) {
    return (await this.sql.exec(query, ...params)).toArray();
  }

  async one(query, ...params) {
    return (await this.all(query, ...params))[0] || null;
  }

  async run(query, ...params) {
    await this.sql.exec(query, ...params);
  }

  get files() {
    return this.store;
  }

  get maxUpload() {
    return Number(this.env.MAX_UPLOAD_BYTES) > 0 ? Number(this.env.MAX_UPLOAD_BYTES) : 100 * 1024 * 1024;
  }

  // The most one request may carry. A Vercel Function takes about 4.5 MB.
  get maxRequest() {
    return Number(this.env.MAX_REQUEST_BYTES) > 0 ? Number(this.env.MAX_REQUEST_BYTES) : this.maxUpload;
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

  async accountById(id) {
    if (!ID_PATTERN.test(String(id || ''))) return null;
    return await this.one(`SELECT * FROM accounts WHERE id = ?`, id);
  }

  async accountByName(name) {
    const clean = String(name || '').trim().toLowerCase();
    if (!clean) return null;
    return await this.one(`SELECT * FROM accounts WHERE name_lc = ?`, clean);
  }

  async createAccount({ name, salt, hash }) {
    const cleanName = String(name || '').trim().slice(0, 24);
    const cleanSalt = String(salt || '');
    const cleanHash = String(hash || '');

    if (!cleanName) throw requestError('Type a name for the account.', 400);
    if (!HEX_PATTERN.test(cleanSalt) || !HEX_PATTERN.test(cleanHash)) {
      throw requestError('That account record is not valid.', 400);
    }
    if (await this.accountByName(cleanName)) throw requestError('That name is already used on this drive.', 409, 'name-taken');

    const now = Date.now();
    const id = `u_${now.toString(36)}_${randomToken(3)}`;
    await this.run(
      `INSERT INTO accounts (id, name, name_lc, salt, hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      cleanName,
      cleanName.toLowerCase(),
      cleanSalt,
      cleanHash,
      now,
      now
    );
    return await this.accountById(id);
  }

  // A name nobody owns still gets a plausible looking record, so asking for it
  // cannot be used to find out who has an account here: the sign-in that
  // follows simply fails.
  async fakeAccount(name) {
    let secret = this.env.DELUXE_FAKE_SECRET || '';
    if (!secret) {
      const row = await this.one(`SELECT value FROM meta WHERE key = 'fake-secret'`);
      if (row) secret = row.value;
      else {
        secret = randomToken(24);
        await this.run(`INSERT INTO meta (key, value) VALUES ('fake-secret', ?) ON CONFLICT DO NOTHING`, secret);
      }
    }
    const clean = String(name || '').trim().slice(0, 24);
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(clean.toLowerCase())));
    return { id: `u_unknown_${digest.slice(0, 16)}`, name: clean, salt: digest.slice(0, 32) };
  }

  async renameAccount(id, name) {
    const clean = String(name || '').trim().slice(0, 24);
    if (!clean) throw requestError('Type a name for the account.', 400);
    const account = await this.accountById(id);
    if (!account) throw requestError('That account is not here.', 404);
    const other = await this.accountByName(clean);
    if (other && other.id !== id) throw requestError('That name is already used on this drive.', 409);
    await this.run(`UPDATE accounts SET name = ?, name_lc = ?, updated_at = ? WHERE id = ?`, clean, clean.toLowerCase(), Date.now(), id);
    return await this.accountById(id);
  }

  async setAccountPassword(id, salt, hash) {
    const cleanSalt = String(salt || '');
    const cleanHash = String(hash || '');
    if (!HEX_PATTERN.test(cleanSalt) || !HEX_PATTERN.test(cleanHash)) {
      throw requestError('That account record is not valid.', 400);
    }
    if (!await this.accountById(id)) throw requestError('That account is not found.', 404);
    await this.run(`UPDATE accounts SET salt = ?, hash = ?, updated_at = ? WHERE id = ?`, cleanSalt, cleanHash, Date.now(), id);
  }

  async deleteAccount(id) {
    if (!await this.accountById(id)) return false;
    await this.run(`DELETE FROM accounts WHERE id = ?`, id);
    for (const table of ['nodes', 'settings', 'blobs']) await this.run(`DELETE FROM ${table} WHERE account_id = ?`, id);
    await this.run(`DELETE FROM shares WHERE account_id = ?`, id);
    await this.run(`DELETE FROM link_codes WHERE account_id = ?`, id);
    await this.run(`DELETE FROM sessions WHERE user_id = ?`, id);
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

  async listNodes(accountId) {
    return (await this.all(`SELECT json FROM nodes WHERE account_id = ?`, accountId)).map((row) => JSON.parse(row.json));
  }

  async getNode(accountId, nodeId) {
    if (!ID_PATTERN.test(String(nodeId || ''))) return null;
    const row = await this.one(`SELECT json FROM nodes WHERE account_id = ? AND id = ?`, accountId, nodeId);
    return row ? JSON.parse(row.json) : null;
  }

  async putNode(accountId, node) {
    if (!node || typeof node !== 'object') throw requestError('That file record is not valid.', 400);
    if (!ID_PATTERN.test(String(node.id || ''))) throw requestError('That file id is not valid.', 400);
    await this.run(
      `INSERT INTO nodes (account_id, id, json) VALUES (?, ?, ?)
       ON CONFLICT (account_id, id) DO UPDATE SET json = excluded.json`,
      accountId,
      node.id,
      JSON.stringify(node)
    );
  }

  async putNodes(accountId, nodes) {
    if (!Array.isArray(nodes)) throw requestError('That list of files is not valid.', 400);
    for (const node of nodes) {
      if (!node || typeof node !== 'object' || !ID_PATTERN.test(String(node.id || ''))) {
        throw requestError('One of those file records is not valid.', 400);
      }
    }
    for (const node of nodes) await this.putNode(accountId, node);
    return nodes.length;
  }

  async deleteNode(accountId, nodeId) {
    if (!ID_PATTERN.test(String(nodeId || ''))) return false;
    await this.run(`DELETE FROM nodes WHERE account_id = ? AND id = ?`, accountId, nodeId);
    return true;
  }

  async getSetting(accountId, key) {
    const row = await this.one(`SELECT json FROM settings WHERE account_id = ? AND key = ?`, accountId, key);
    return row ? JSON.parse(row.json) : undefined;
  }

  async putSetting(accountId, key, value) {
    await this.run(
      `INSERT INTO settings (account_id, key, json) VALUES (?, ?, ?)
       ON CONFLICT (account_id, key) DO UPDATE SET json = excluded.json`,
      accountId,
      key,
      JSON.stringify(value === undefined ? null : value)
    );
  }

  async deleteSetting(accountId, key) {
    await this.run(`DELETE FROM settings WHERE account_id = ? AND key = ?`, accountId, key);
  }

  /* ---------------- file contents ---------------- */

  async blobInfo(accountId, blobId) {
    const row = await this.one(`SELECT mime, size, updated_at FROM blobs WHERE account_id = ? AND id = ?`, accountId, blobId);
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
    await this.run(
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

  // One piece of a file sent in several requests: ?offset=<bytes>, and
  // ?last=1 on the final piece. Each piece but the last is a whole number of
  // 1 MB rows. The file only becomes readable once the last piece is in.
  async saveBlobPart(accountId, blobId, request, mime, offset, last) {
    const key = this.blobKey(accountId, blobId);
    if (!key) throw requestError('That file id is not valid.', 400);
    if (!this.files.parts) throw requestError('Send this file in one request.', 400);
    if (!Number.isInteger(offset) || offset < 0 || offset % CHUNK || offset >= this.maxUpload) {
      throw requestError('That piece of the file is not valid.', 400);
    }
    if (offset === 0) {
      await this.run(`DELETE FROM blobs WHERE account_id = ? AND id = ?`, accountId, blobId);
      await this.files.delete(key);
    } else if ((await this.files.total(key)) !== offset) {
      throw requestError('A piece of this file is missing. Send it again.', 409);
    }
    const { size } = await this.files.putAt(key, offset / CHUNK, request.body || (await request.arrayBuffer()));
    if (!last && (!size || size % CHUNK)) {
      await this.files.delete(key);
      throw requestError('That piece of the file is not valid.', 400);
    }
    const total = offset + size;
    if (total > this.maxUpload) {
      await this.files.delete(key);
      throw requestError('That file is too large for this server.', 413);
    }
    if (last) {
      const cleanMime = String(mime || 'application/octet-stream').slice(0, 120);
      await this.run(
        `INSERT INTO blobs (account_id, id, mime, size, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (account_id, id) DO UPDATE SET mime = excluded.mime, size = excluded.size, updated_at = excluded.updated_at`,
        accountId,
        blobId,
        cleanMime,
        total,
        Date.now()
      );
    }
    return { received: total, done: !!last };
  }

  async deleteBlob(accountId, blobId) {
    const key = this.blobKey(accountId, blobId);
    if (!key) return false;
    await this.files.delete(key);
    await this.run(`DELETE FROM blobs WHERE account_id = ? AND id = ?`, accountId, blobId);
    return true;
  }

  async clearAccountData(accountId) {
    await this.run(`DELETE FROM nodes WHERE account_id = ?`, accountId);
    await this.run(`DELETE FROM settings WHERE account_id = ?`, accountId);
    await this.run(`DELETE FROM blobs WHERE account_id = ?`, accountId);
    await this.run(`DELETE FROM shares WHERE account_id = ?`, accountId);
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

  /* ---------------- files added by Deluxe Convert ---------------- */

  static cleanFileName(value) {
    const clean = String(value || '')
      .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
      .trim()
      .slice(0, 200);
    return clean && clean !== '.' && clean !== '..' ? clean : 'Converted file';
  }

  static cleanMime(value) {
    const mime = String(value || '').split(';')[0].trim().toLowerCase();
    return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) ? mime : 'application/octet-stream';
  }

  static newNodeId() {
    return `n_${Date.now().toString(36)}_${randomToken(4)}`;
  }

  // A name not yet used among the folder's (not trashed) items: "a.pdf",
  // then "a (1).pdf", "a (2).pdf", ...
  async uniqueChildName(accountId, parentId, name) {
    const taken = new Set(
      (await this.listNodes(accountId))
        .filter((node) => !node.trashed && (node.parentId || null) === parentId)
        .map((node) => String(node.name || '').toLowerCase())
    );
    if (!taken.has(name.toLowerCase())) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const tail = dot > 0 ? name.slice(dot) : '';
    for (let index = 1; index < 10000; index += 1) {
      const candidate = `${stem} (${index})${tail}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${stem} (${Date.now()})${tail}`;
  }

  async importFolder(accountId) {
    const existing = (await this.listNodes(accountId)).find(
      (node) =>
        node.type === 'folder' &&
        !node.trashed &&
        !node.parentId &&
        String(node.name || '').toLowerCase() === IMPORT_FOLDER.toLowerCase()
    );
    if (existing) return existing.id;
    const now = Date.now();
    const folder = {
      id: HubCore.newNodeId(),
      ownerId: accountId,
      parentId: null,
      type: 'folder',
      name: await this.uniqueChildName(accountId, null, IMPORT_FOLDER),
      mime: '',
      size: 0,
      starred: false,
      trashed: false,
      trashedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.putNode(accountId, folder);
    return folder.id;
  }

  async importFile(accountId, name, mime, request) {
    const id = HubCore.newNodeId();
    const size = await this.saveBlob(accountId, id, request, mime);
    if (!size) {
      await this.deleteBlob(accountId, id);
      throw requestError('That file is empty.', 400);
    }
    if (size > this.maxUpload) {
      await this.deleteBlob(accountId, id);
      throw requestError('That file is too large for Deluxe Drive.', 413);
    }
    return this.finishImport(accountId, id, name, mime, size);
  }

  // The file's contents are stored under id; this files it in the drive.
  async finishImport(accountId, id, name, mime, size) {
    const parentId = await this.importFolder(accountId);
    const now = Date.now();
    const node = {
      id,
      ownerId: accountId,
      parentId,
      type: 'file',
      name: await this.uniqueChildName(accountId, parentId, name),
      mime,
      size,
      starred: false,
      trashed: false,
      trashedAt: null,
      createdAt: now,
      updatedAt: now,
      source: 'deluxe-convert',
    };
    await this.putNode(accountId, node);
    return node;
  }

  /* ---------------- share links ---------------- */

  async ensureShare(accountId, blobId, name) {
    const existing = await this.one(`SELECT token FROM shares WHERE account_id = ? AND blob_id = ?`, accountId, blobId);
    if (existing) return existing.token;
    const token = randomToken(16);
    await this.run(
      `INSERT INTO shares (token, account_id, blob_id, name, created_at) VALUES (?, ?, ?, ?, ?)`,
      token,
      accountId,
      blobId,
      String(name || '').slice(0, 200),
      Date.now()
    );
    return token;
  }

  async shareByToken(token) {
    if (!/^[0-9a-f]{8,64}$/i.test(String(token || ''))) return null;
    return await this.one(`SELECT * FROM shares WHERE token = ?`, token);
  }

  async revokeShare(accountId, blobId) {
    await this.run(`DELETE FROM shares WHERE account_id = ? AND blob_id = ?`, accountId, blobId);
  }

  async listShares(accountId) {
    return await this.all(`SELECT * FROM shares WHERE account_id = ? ORDER BY created_at DESC`, accountId);
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

  static linkApp(value) {
    const app = String(value || DEFAULT_LINK_APP).toLowerCase();
    return Object.prototype.hasOwnProperty.call(LINK_APPS, app) ? app : null;
  }

  // A new id each time, letters and digits only (no 0, O, 1 or I to misread),
  // 12 characters, made for one app. Making one ends any earlier id of the same
  // account for that app.
  async createLinkId(accountId, app = DEFAULT_LINK_APP) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    let raw = '';
    for (const byte of bytes) raw += LINK_ALPHABET[byte % LINK_ALPHABET.length];
    const now = Date.now();
    await this.run(`DELETE FROM link_codes WHERE expires_at <= ?`, now);
    await this.run(
      `DELETE FROM link_codes WHERE account_id = ? AND COALESCE(client, ?) = ?`,
      accountId,
      DEFAULT_LINK_APP,
      app
    );
    await this.run(
      `INSERT INTO link_codes (code_hash, account_id, expires_at, client) VALUES (?, ?, ?, ?)`,
      await this.hashLinkId(raw),
      accountId,
      now + LINK_TTL_SECONDS * 1000,
      app
    );
    return { linkId: HubCore.formatLinkId(raw), expiresIn: LINK_TTL_SECONDS, app };
  }

  // Finds the account a link id belongs to and uses the id up. An id made for
  // another app is left alone and reported, so it can still be used there.
  async takeLinkId(value, app = DEFAULT_LINK_APP) {
    const clean = HubCore.cleanLinkId(value);
    if (clean.length !== 12) return null;
    const hash = await this.hashLinkId(clean);
    const row = await this.one(`SELECT account_id, expires_at, client FROM link_codes WHERE code_hash = ?`, hash);
    if (!row) return null;
    const madeFor = row.client || DEFAULT_LINK_APP;
    if (madeFor !== app && row.expires_at > Date.now()) return { wrongApp: madeFor };
    await this.run(`DELETE FROM link_codes WHERE code_hash = ?`, hash);
    if (row.expires_at <= Date.now()) return null;
    const account = await this.accountById(row.account_id);
    return account ? { account } : null;
  }

  /* ---------------- sessions ---------------- */

  async createSession(userId, options = {}) {
    const ttlSeconds = Number(options.ttlSeconds) > 0 ? Number(options.ttlSeconds) : SESSION_TTL_SECONDS;
    const now = Date.now();
    await this.run(`DELETE FROM sessions WHERE expires_at <= ?`, now);
    const token = randomToken(32);
    await this.run(
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

  async sessionFor(token) {
    const clean = String(token || '');
    if (!clean) return null;
    const row = await this.one(`SELECT * FROM sessions WHERE token = ?`, clean);
    if (!row) return null;
    if (row.expires_at <= Date.now()) {
      await this.run(`DELETE FROM sessions WHERE token = ?`, clean);
      return null;
    }
    return { token: row.token, userId: row.user_id, clientId: row.client_id, scope: row.scope };
  }

  async dropSession(token) {
    await this.run(`DELETE FROM sessions WHERE token = ?`, String(token || ''));
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
  async need(request) {
    const token = bearerToken(request);
    const session = token ? await this.sessionFor(token) : null;
    if (!session) return [null, json(401, { error: 'Sign in to Deluxe Drive again.', code: 'unauthorized' })];

    // The key Deluxe Convert gets for a link id may add files and say whose
    // drive it is, and nothing else: it cannot list, read or change files.
    if (session.clientId === 'deluxe-convert') {
      const path = new URL(request.url).pathname;
      const allowed =
        (request.method === 'POST' && path === '/api/import') ||
        (request.method === 'POST' && /^\/api\/import\/[^/]+\/share$/.test(path)) ||
        (request.method === 'GET' && path === '/api/auth/me');
      if (!allowed) {
        return [null, json(403, { error: 'Deluxe Convert can only add files to this drive.', code: 'import-only' })];
      }
      return [session, null];
    }

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

    r('GET', '/api/health', async () =>
      json(200, {
        ok: true,
        name: SERVER_NAME,
        server: true,
        storage: 'server',
        files: this.store.name,
        version: 'worker 2',
        linkIds: { create: '/api/link', redeem: '/api/link/redeem', seconds: LINK_TTL_SECONDS, apps: Object.keys(LINK_APPS) },
        import: '/api/import',
        limits: {
          uploadBytes: this.maxUpload,
          // Bigger files are sent in pieces of partBytes (see saveBlobPart).
          requestBytes: this.maxRequest,
          partBytes: this.files.parts ? PART : 0,
        },
      })
    );

    r('POST', '/api/auth/session', async ({ request }) => {
      const body = await readJsonBody(request);
      const userId = String(body.userId || '');
      if (this.tooManyFailures(`session:${userId}`)) {
        return json(429, { error: 'Too many wrong tries. Wait a few minutes and try again.', code: 'rate-limited' });
      }
      const account = await this.accountById(userId);
      if (!account || !safeEqual(account.hash, String(body.hash || ''))) {
        this.noteFailure(`session:${userId}`);
        return json(401, { error: 'That account did not match.', code: 'unauthorized' });
      }
      this.clearFailures(`session:${userId}`);
      const session = await this.createSession(account.id, { scope: 'drive', ttlSeconds: SESSION_TTL_SECONDS });
      return json(200, { token: session.token, expiresIn: session.expiresIn, user: { id: account.id, name: account.name } });
    });

    r('GET', '/api/auth/me', async ({ request }) => {
      const [session, denied] = await this.need(request);
      if (denied) return denied;
      const account = await this.accountById(session.userId);
      if (!account) return json(401, { error: 'Sign in to Deluxe Drive again.', code: 'unauthorized' });
      return json(200, { user: { id: account.id, name: account.name } });
    });

    r('POST', '/api/accounts', async ({ request }) => {
      const body = await readJsonBody(request);
      let account;
      try {
        account = await this.createAccount({ name: body.name, salt: body.salt, hash: body.hash });
      } catch (error) {
        const status = error.status || 500;
        return json(status, {
          error: error.status ? error.message : 'That account could not be made.',
          code: error.code || (status === 409 ? 'name-taken' : 'create-failed'),
        });
      }
      const session = await this.createSession(account.id, { scope: 'drive', ttlSeconds: SESSION_TTL_SECONDS });
      return json(201, { token: session.token, expiresIn: session.expiresIn, user: { id: account.id, name: account.name } });
    });

    r('POST', '/api/accounts/find', async ({ request }) => {
      const body = await readJsonBody(request);
      const name = String(body.name || '').trim();
      if (!name) return json(400, { error: 'Type your account name.' });
      const account = await this.accountByName(name);
      return json(200, account ? this.publicAccount(account) : await this.fakeAccount(name));
    });

    r('GET', '/api/accounts/:id', async ({ params }) => {
      const account = await this.accountById(params.id);
      if (!account) return json(404, { error: 'That account is not here.' });
      return json(200, this.publicAccount(account));
    });

    r('PATCH', '/api/accounts/:id', async ({ request, params }) => {
      const [session, denied] = await this.need(request);
      if (denied) return denied;
      const notYours = this.own(session, params.id);
      if (notYours) return notYours;
      const body = await readJsonBody(request);
      try {
        const account = await this.renameAccount(session.userId, body.name);
        return json(200, { user: { id: account.id, name: account.name } });
      } catch (error) {
        return json(error.status || 500, { error: error.message || 'That name could not be saved.' });
      }
    });

    r('POST', '/api/accounts/:id/password', async ({ request, params }) => {
      const [session, denied] = await this.need(request);
      if (denied) return denied;
      const notYours = this.own(session, params.id);
      if (notYours) return notYours;
      const body = await readJsonBody(request);
      const account = await this.accountById(session.userId);
      if (!account || !safeEqual(account.hash, String(body.currentHash || ''))) {
        return json(401, { error: 'That password is not correct.', code: 'unauthorized' });
      }
      try {
        await this.setAccountPassword(session.userId, body.salt, body.hash);
        return json(200, { ok: true });
      } catch (error) {
        return json(error.status || 500, { error: error.message || 'That password could not be saved.' });
      }
    });

    r('DELETE', '/api/accounts/:id', async ({ request, params }) => {
      const [session, denied] = await this.need(request);
      if (denied) return denied;
      const notYours = this.own(session, params.id);
      if (notYours) return notYours;
      const removed = await this.deleteAccount(session.userId);
      if (!removed) return json(404, { error: 'That account is not here.' });
      return json(200, { ok: true });
    });

    r('GET', '/api/db/nodes', async ({ request }) => {
      const [session, denied] = await this.need(request);
      if (denied) return denied;
      return json(200, { nodes: await this.listNodes(session.userId) });
    });

    r('GET', '/api/db/nodes/:id', async ({ request, params }) => {
      const [session, denied] = await this.need(request);
      if (denied) return denied;
      const node = await this.getNode(session.userId, params.id);
      return node ? json(200, { node }) : json(404, { error: 'That file is not here.' });
    });

    r('POST', '/api/db/nodes', async ({ request }) => {
      const [session, denied] = await this.need(request);
      if (denied) return denied;
      const body = await readJsonBody(request);
      try {
        return json(200, { ok: true, count: await this.putNodes(session.userId, body.nodes) });
      } catch (error) {
        return json(error.status || 400, { error: error.message || 'Those files could not be saved.' });
      }
    });

    r('PUT', '/api/db/nodes/:id', async ({ request, params }) => {
      const [session, denied] = await this.need(request);
      if (denied) return denied;
      const body = await readJsonBody(request);
      const node = { ...body, id: params.id };
      try {
        await this.putNode(session.userId, node);
        return json(200, { ok: true, id: node.id });
      } catch (error) {
        return json(error.status || 400, { error: error.message || 'That file could not be saved.' });
      }
    });

    r('DELETE', '/api/db/nodes/:id', async ({ request, params }) => {
      const [session, denied] = await this.need(request);
      if (denied) return denied;
      // Blobs and share links are keyed by the node id, so deleting the file
      // also ends its stored data and any link that still pointed at it.
      await this.deleteNode(session.userId, params.id);
      await this.deleteBlob(session.userId, params.id);
      await this.revokeShare(session.userId, params.id);
      return json(200, { ok: true });
    });

    r('GET', '/api/db/blobs/:id', async ({ request, params }) => {
      const [session, denied] = await this.need(request);
      if (denied) return denied;
      const info = await this.blobInfo(session.userId, params.id);
      if (!info) return json(404, { error: 'That file has no stored data.' });
      const node = await this.getNode(session.userId, params.id);
      return this.streamBlob(request, info, node ? node.name : params.id, false);
    });

    r('PUT', '/api/db/blobs/:id', async ({ request, params, url }) => {
      const [session, denied] = await this.need(request);
      if (denied) return denied;
      if (Number(request.headers.get('content-length') || 0) > this.maxUpload) {
        return json(413, { error: 'That file is too large for this server.' });
      }
      const mime = String(request.headers.get('x-deluxe-mime') || request.headers.get('content-type') || 'application/octet-stream');
      if (url.searchParams.has('offset')) {
        try {
          const offset = Number(url.searchParams.get('offset'));
          const part = await this.saveBlobPart(session.userId, params.id, request, mime, offset, url.searchParams.get('last') === '1');
          return json(part.done ? 201 : 202, { ok: true, id: params.id, size: part.received, done: part.done, mime });
        } catch (error) {
          return json(error.status || 400, { error: error.status ? error.message : 'That file could not be stored.' });
        }
      }
      try {
        const size = await this.saveBlob(session.userId, params.id, request, mime);
        return json(201, { ok: true, id: params.id, size, mime });
      } catch (error) {
        return json(error.status || 400, { error: error.status ? error.message : 'That file could not be stored.' });
      }
    });

    r('DELETE', '/api/db/blobs/:id', async ({ request, params }) => {
      const [session, denied] = await this.need(request);
      if (denied) return denied;
      await this.deleteBlob(session.userId, params.id);
      return json(200, { ok: true });
    });

    r('GET', '/api/db/settings/:key', async ({ request, params }) => {
      const [session, denied] = await this.need(request);
      if (denied) return denied;
      if (!SETTINGS_KEY.test(params.key)) return json(400, { error: 'That setting name is not valid.' });
      const value = await this.getSetting(session.userId, params.key);
      return value === undefined ? json(404, { error: 'That setting is not set.' }) : json(200, { key: params.key, value });
    });

    r('PUT', '/api/db/settings/:key', async ({ request, params }) => {
      const [session, denied] = await this.need(request);
      if (denied) return denied;
      if (!SETTINGS_KEY.test(params.key)) return json(400, { error: 'That setting key is not valid.' });
      const body = await readJsonBody(request);
      await this.putSetting(session.userId, params.key, body.value);
      return json(200, { ok: true, key: params.key });
    });

    r('DELETE', '/api/db/settings/:key', async ({ request, params }) => {
      const [session, denied] = await this.need(request);
      if (denied) return denied;
      await this.deleteSetting(session.userId, params.key);
      return json(200, { ok: true });
    });

    r('POST', '/api/db/clear', async ({ request }) => {
      const [session, denied] = await this.need(request);
      if (denied) return denied;
      await this.clearAccountData(session.userId);
      return json(200, { ok: true });
    });

    r('POST', '/api/files/:id/share', async ({ request, params, url }) => {
      const [session, denied] = await this.need(request);
      if (denied) return denied;
      const node = await this.getNode(session.userId, params.id);
      if (!node) return json(404, { error: 'That file is not here.' });
      if (node.type !== 'file') return json(400, { error: 'Folders cannot be shared on their own.' });
      const token = await this.ensureShare(session.userId, node.id, node.name);
      return json(200, { token, path: `/s/${token}`, url: `${origin(url)}/s/${token}`, name: node.name });
    });

    r('DELETE', '/api/files/:id/share', async ({ request, params }) => {
      const [session, denied] = await this.need(request);
      if (denied) return denied;
      await this.revokeShare(session.userId, params.id);
      return json(200, { ok: true });
    });

    r('GET', '/api/files/shares', async ({ request, url }) => {
      const [session, denied] = await this.need(request);
      if (denied) return denied;
      return json(200, {
        shares: (await this.listShares(session.userId)).map((share) => ({
          token: share.token,
          name: share.name,
          fileId: share.blob_id,
          createdAt: share.created_at,
          path: `/s/${share.token}`,
          url: `${origin(url)}/s/${share.token}`,
        })),
      });
    });

    r('GET', '/api/shared/:token', async ({ request, params }) => this.serveShared(request, params.token));

    r('POST', '/api/link', async ({ request }) => {
      const [session, denied] = await this.need(request);
      if (denied) return denied;
      if (session.clientId) return json(403, { error: 'Make a link id from Deluxe Drive itself.' });
      const body = await readJsonBody(request);
      const app = HubCore.linkApp(body.app);
      if (!app) return json(400, { error: 'That app cannot connect to Deluxe Drive.', code: 'unknown-app' });
      return json(201, await this.createLinkId(session.userId, app));
    });

    // Deluxe Docs (no app, or app "deluxe-docs") and Deluxe Convert (app
    // "deluxe-convert") send the pasted id here. The account is found from the
    // id alone; Docs gets a key that can only read, Convert one that can only
    // add files.
    r('POST', '/api/link/redeem', async ({ request }) => {
      const who = `redeem:${request.headers.get('cf-connecting-ip') || 'unknown'}`;
      if (this.tooManyFailures(who)) {
        return json(429, { error: 'Too many wrong link ids. Wait a few minutes and try again.', code: 'rate-limited' });
      }
      const body = await readJsonBody(request);
      const app = HubCore.linkApp(body.app);
      if (!app) return json(400, { error: 'That app cannot connect to Deluxe Drive.', code: 'unknown-app' });
      const found = await this.takeLinkId(body.linkId, app);
      if (found && found.wrongApp) {
        const appName = LINK_APPS[found.wrongApp].name;
        return json(409, {
          error: `This link ID was made for ${appName}. In Deluxe Drive, use Connect ${LINK_APPS[app].name} instead.`,
          code: 'link-wrong-app',
        });
      }
      if (!found) {
        this.noteFailure(who);
        return json(404, {
          error: 'This code has already been used or is too old. In Deluxe Drive, tap Generate link ID again.',
          code: 'link-not-found',
        });
      }
      const { account } = found;
      const session = await this.createSession(account.id, {
        clientId: app,
        scope: LINK_APPS[app].scope,
        ttlSeconds: app === 'deluxe-docs' ? DOCS_SESSION_SECONDS : APP_SESSION_SECONDS,
      });
      return json(200, {
        token: session.token,
        expiresIn: session.expiresIn,
        scope: LINK_APPS[app].scope,
        user: { id: account.id, name: account.name },
        driveName: SERVER_NAME,
      });
    });

    // A share link for a file Deluxe Convert added earlier (and only such a
    // file), so asking for a link later does not upload the file again.
    r('POST', '/api/import/:id/share', async ({ request, params, url }) => {
      const [session, denied] = await this.need(request);
      if (denied) return denied;
      const node = await this.getNode(session.userId, params.id);
      if (!node || node.type !== 'file' || node.trashed || node.source !== 'deluxe-convert') {
        return json(404, { error: 'That file is no longer in Deluxe Drive. Share it again.' });
      }
      const token = await this.ensureShare(session.userId, node.id, node.name);
      return json(200, { file: { id: node.id, name: node.name }, share: { token, url: `${origin(url)}/s/${token}` } });
    });

    // Deluxe Convert sends a converted file here: the body is the file, its
    // name is in X-Deluxe-Name (URI-encoded) and its type in Content-Type. It
    // lands in a "Deluxe Convert" folder at the top of the drive. ?share=1
    // also makes a share link for it.
    r('POST', '/api/import', async ({ request, url }) => {
      const [session, denied] = await this.need(request);
      if (denied) return denied;
      const declared = Number(request.headers.get('content-length') || 0);
      if (declared > this.maxUpload) return json(413, { error: 'That file is too large for Deluxe Drive.' });
      if (!await this.accountById(session.userId)) return json(401, { error: 'Sign in to Deluxe Drive again.', code: 'unauthorized' });
      const name = HubCore.cleanFileName(decodeSegment(String(request.headers.get('x-deluxe-name') || '')));
      const mime = HubCore.cleanMime(request.headers.get('x-deluxe-mime') || request.headers.get('content-type'));
      if (url.searchParams.has('offset')) {
        // A big file arrives in pieces. The first piece (offset 0) gets an
        // upload id back; the others name it. The id is new and unused, so a
        // piece can never land on a file that is already in the drive.
        const offset = Number(url.searchParams.get('offset'));
        const last = url.searchParams.get('last') === '1';
        let id = String(url.searchParams.get('upload') || '');
        if (offset === 0) id = HubCore.newNodeId();
        else if (!ID_PATTERN.test(id) || !id.startsWith('n_') || (await this.getNode(session.userId, id)) || (await this.blobInfo(session.userId, id))) {
          return json(400, { error: 'That upload is not valid. Share the file again.' });
        }
        try {
          const part = await this.saveBlobPart(session.userId, id, request, mime, offset, last);
          if (!part.done) return json(202, { ok: true, upload: id, received: part.received });
          if (!part.received) {
            await this.deleteBlob(session.userId, id);
            return json(400, { error: 'That file is empty.' });
          }
          const node = await this.finishImport(session.userId, id, name, mime, part.received);
          const result = { ok: true, file: { id: node.id, name: node.name, size: node.size, mime: node.mime }, folder: IMPORT_FOLDER };
          if (url.searchParams.get('share') === '1') {
            const token = await this.ensureShare(session.userId, node.id, node.name);
            result.share = { token, url: `${origin(url)}/s/${token}` };
          }
          return json(201, result);
        } catch (error) {
          return json(error.status || 400, { error: error.status ? error.message : 'That file could not be added.' });
        }
      }
      try {
        const node = await this.importFile(session.userId, name, mime, request);
        const result = { ok: true, file: { id: node.id, name: node.name, size: node.size, mime: node.mime }, folder: IMPORT_FOLDER };
        if (url.searchParams.get('share') === '1') {
          const token = await this.ensureShare(session.userId, node.id, node.name);
          result.share = { token, url: `${origin(url)}/s/${token}` };
        }
        return json(201, result);
      } catch (error) {
        return json(error.status || 400, { error: error.status ? error.message : 'That file could not be added.' });
      }
    });

    // Disconnecting Deluxe Docs ends its key.
    r('DELETE', '/api/link/session', async ({ request }) => {
      const token = bearerToken(request);
      if (token) await this.dropSession(token);
      return json(200, { ok: true });
    });
  }

  /* ---------------- public pieces ---------------- */

  async serveShared(request, token) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json(405, { error: 'Only reading is allowed here.' });
    }
    const share = await this.shareByToken(token);
    if (!share) return text(404, 'Not found');
    const info = await this.blobInfo(share.account_id, share.blob_id);
    if (!info) return text(404, 'Not found');
    return this.streamBlob(request, info, share.name || share.blob_id, false);
  }

  async handle(request) {
    try {
      await this.ready();
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
