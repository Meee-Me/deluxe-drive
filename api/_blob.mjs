// Deluxe Drive's storage on Vercel Blob, so the drive works on Vercel with
// nothing to set up beyond a Blob store connected to the project.
//
// The server code (worker/hub.js) talks SQL. Here that SQL runs on an
// in-memory SQLite database (node:sqlite) whose contents - accounts, file
// records, share links, link IDs, sessions - are kept in one private blob,
// deluxe-drive/state.json:
//   - before a request it is read again if it changed (a cheap ETag check),
//   - after a request that changed something it is written back with
//     ifMatch, so two writes can never silently overwrite each other.
// File contents are kept as their own private blobs, one per piece of up to
// 4 MB (a Vercel Function takes about 4.5 MB per request), and read back
// with Range requests so video and PDF can seek.
//
// The Blob SDK is passed in, so the tests can run this against a fake.
import { DatabaseSync } from 'node:sqlite';

const STATE_PATH = 'deluxe-drive/state.json';
const FILE_PREFIX = 'deluxe-drive/files/';
const CHUNK = 1024 * 1024;
// How long a read may trust what this instance last loaded.
const READ_FRESH_MS = 3000;

function toBuffer(value) {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return value;
}

async function readAll(body) {
  if (!body) return Buffer.alloc(0);
  if (typeof body.getReader === 'function') return Buffer.from(await new Response(body).arrayBuffer());
  return toBuffer(body);
}

// The SDK's error classes do not set a name, so they are told apart by class
// when the SDK is at hand, and by their message otherwise.
function isPreconditionFailure(error, sdk) {
  if (!error) return false;
  if (sdk && sdk.BlobPreconditionFailedError && error instanceof sdk.BlobPreconditionFailedError) return true;
  return /precondition/i.test(String(error.message || ''));
}

function isNotFound(error, sdk) {
  if (!error) return false;
  if (sdk && sdk.BlobNotFoundError && error instanceof sdk.BlobNotFoundError) return true;
  return /does not exist|not.?found/i.test(String(error.message || ''));
}

/* ------------------------------------------------------------------ */
/* The database: in-memory SQLite, kept in one private blob            */
/* ------------------------------------------------------------------ */

export class BlobState {
  constructor(sdk) {
    this.sdk = sdk;
    this.db = new DatabaseSync(':memory:');
    this.etag = null; // the state blob this instance holds, or null for none yet
    this.checkedAt = 0;
    this.dirty = false;
  }

  // The hub's sql.exec(query, ...params) -> { toArray() }.
  exec(query, ...params) {
    params = params.map((p) => (p instanceof ArrayBuffer ? new Uint8Array(p) : p));
    const stmt = this.db.prepare(query);
    const reads = /^\s*(select|with)\b/i.test(query) || /\breturning\b/i.test(query);
    // Reads, and making tables that may already be there, change nothing worth saving.
    if (!/^\s*(select\b|create table if not exists\b|alter table\b)/i.test(query)) this.dirty = true;
    if (reads) {
      const rows = stmt.all(...params);
      return { toArray: () => rows };
    }
    stmt.run(...params);
    return { toArray: () => [] };
  }

  dump() {
    const tables = this.db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all();
    return JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      tables: tables.map(({ name, sql }) => ({ name, sql, rows: this.db.prepare(`SELECT * FROM "${name}"`).all() })),
    });
  }

  restore(text) {
    const data = JSON.parse(text);
    const db = new DatabaseSync(':memory:');
    db.exec('BEGIN');
    for (const table of data.tables || []) {
      db.exec(table.sql);
      const rows = table.rows || [];
      if (!rows.length) continue;
      const columns = Object.keys(rows[0]);
      const insert = db.prepare(
        `INSERT INTO "${table.name}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
      );
      for (const row of rows) insert.run(...columns.map((c) => row[c]));
    }
    db.exec('COMMIT');
    this.db.close();
    this.db = db;
  }

  reset() {
    this.db.close();
    this.db = new DatabaseSync(':memory:');
  }

  // Reads the state blob again if it changed since this instance loaded it.
  // Returns true when the database was replaced (the hub must make its tables
  // again if the blob was empty).
  async sync({ force = false, mutating = false } = {}) {
    const now = Date.now();
    if (!force && !mutating && now - this.checkedAt < READ_FRESH_MS) return false;
    const result = await this.sdk.get(STATE_PATH, {
      access: 'private',
      useCache: false,
      ...(this.etag && !force ? { ifNoneMatch: this.etag } : {}),
    });
    this.checkedAt = Date.now();
    if (!result) {
      // Nothing stored yet (a new drive), or it was removed.
      if (this.etag) {
        this.reset();
        this.etag = null;
        this.dirty = false;
        return true;
      }
      return false;
    }
    if (result.statusCode === 304) return false;
    const text = (await readAll(result.stream)).toString('utf8');
    this.restore(text);
    this.etag = result.blob.etag;
    this.dirty = false;
    return true;
  }

  // Writes the database back if a request changed it. ifMatch makes this fail
  // (BlobPreconditionFailedError) if another instance wrote in between.
  async persist() {
    if (!this.dirty) return;
    const body = this.dump();
    const options = {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
      cacheControlMaxAge: 60,
    };
    if (this.etag) options.ifMatch = this.etag;
    else options.allowOverwrite = false; // the very first write: never replace one made meanwhile
    const result = await this.sdk.put(STATE_PATH, body, options);
    this.etag = result.etag;
    this.checkedAt = Date.now();
    this.dirty = false;
  }
}

/* ------------------------------------------------------------------ */
/* File contents: private blobs, one per piece                         */
/* ------------------------------------------------------------------ */

const PARTS_TABLE = `CREATE TABLE IF NOT EXISTS blob_parts (
  key TEXT NOT NULL, first INTEGER NOT NULL, size INTEGER NOT NULL, pathname TEXT NOT NULL,
  PRIMARY KEY (key, first))`;

export class BlobFiles {
  constructor(state, sdk) {
    this.state = state;
    this.sdk = sdk;
    this.name = 'vercel-blob';
    this.parts = true;
  }

  rows(query, ...params) {
    this.state.exec(PARTS_TABLE);
    return this.state.exec(query, ...params).toArray();
  }

  async removeParts(rows) {
    if (!rows.length) return;
    try {
      await this.sdk.del(rows.map((row) => row.pathname));
    } catch (error) {
      if (!isNotFound(error, this.sdk)) console.error('Could not delete file pieces:', error.message);
    }
  }

  // Stores body as the piece that starts at 1 MB row `first`, replacing that
  // piece and everything after it.
  async putAt(key, first, body) {
    const bytes = await readAll(body);
    const later = this.rows(`SELECT pathname FROM blob_parts WHERE key = ? AND first >= ?`, key, first);
    await this.removeParts(later);
    this.rows(`DELETE FROM blob_parts WHERE key = ? AND first >= ?`, key, first);
    if (bytes.length) {
      const saved = await this.sdk.put(`${FILE_PREFIX}${key}/${first}`, bytes, {
        access: 'private',
        addRandomSuffix: true,
        contentType: 'application/octet-stream',
      });
      this.rows(
        `INSERT INTO blob_parts (key, first, size, pathname) VALUES (?, ?, ?, ?)`,
        key,
        first,
        bytes.length,
        saved.pathname
      );
    }
    return { size: bytes.length, rows: Math.ceil(bytes.length / CHUNK) };
  }

  async put(key, body) {
    await this.delete(key);
    return this.putAt(key, 0, body);
  }

  async total(key) {
    const row = this.rows(`SELECT COALESCE(SUM(size), 0) AS n FROM blob_parts WHERE key = ?`, key)[0];
    return Number(row && row.n) || 0;
  }

  async get(key, options) {
    const parts = this.rows(`SELECT first, size, pathname FROM blob_parts WHERE key = ? ORDER BY first`, key);
    const total = parts.reduce((sum, part) => sum + part.size, 0);
    if (!total) return null;

    const start = options && options.range ? options.range.offset : 0;
    const end = Math.min(total, options && options.range ? options.range.offset + options.range.length : total);
    const wanted = [];
    for (const part of parts) {
      const from = part.first * CHUNK;
      const to = from + part.size;
      if (to <= start || from >= end) continue;
      wanted.push({ pathname: part.pathname, a: Math.max(start, from) - from, b: Math.min(end, to) - from - 1 });
    }

    const sdk = this.sdk;
    let index = 0;
    let reader = null;
    const body = new ReadableStream({
      async pull(controller) {
        for (;;) {
          if (!reader) {
            if (index >= wanted.length) {
              controller.close();
              return;
            }
            const piece = wanted[index++];
            const got = await sdk.get(piece.pathname, { access: 'private', headers: { Range: `bytes=${piece.a}-${piece.b}` } });
            if (!got || !got.stream) {
              controller.error(new Error('A stored file is missing a piece.'));
              return;
            }
            reader = got.stream.getReader();
          }
          const { done, value } = await reader.read();
          if (done) {
            reader = null;
            continue;
          }
          controller.enqueue(value);
          return;
        }
      },
      cancel() {
        if (reader) reader.cancel().catch(() => {});
      },
    });
    return { body, size: end - start };
  }

  async delete(keys) {
    for (const key of [].concat(keys)) {
      await this.removeParts(this.rows(`SELECT pathname FROM blob_parts WHERE key = ?`, key));
      this.rows(`DELETE FROM blob_parts WHERE key = ?`, key);
    }
  }

  async deletePrefix(prefix) {
    const rows = this.rows(`SELECT pathname FROM blob_parts WHERE substr(key, 1, ?) = ?`, prefix.length, prefix);
    await this.removeParts(rows);
    this.rows(`DELETE FROM blob_parts WHERE substr(key, 1, ?) = ?`, prefix.length, prefix);
  }
}

/* ------------------------------------------------------------------ */
/* One request at a time per instance, with load / save around it      */
/* ------------------------------------------------------------------ */

export class BlobBackend {
  constructor(sdk, makeHub) {
    this.state = new BlobState(sdk);
    this.files = new BlobFiles(this.state, sdk);
    this.hub = makeHub(this.state, this.files);
    this.queue = Promise.resolve();
  }

  // A database loaded from the blob may lack tables (a new drive) or a column
  // (an older one): the hub makes them again on its next request.
  reloaded() {
    this.hub.readyPromise = null;
  }

  // Requests run one after another, so the in-memory database is never
  // changed by two at once. A file being downloaded keeps streaming after its
  // turn ends.
  run(task) {
    const turn = this.queue.then(task, task);
    this.queue = turn.catch(() => {});
    return turn;
  }

  handle(request) {
    const mutating = !['GET', 'HEAD'].includes(request.method);
    return this.run(async () => {
      if (await this.state.sync({ mutating })) this.reloaded();
      this.state.dirty = false;
      const response = await this.hub.handle(request);
      try {
        await this.state.persist();
      } catch (error) {
        // Something else wrote first, or Blob could not be reached: drop what
        // this request changed and load the stored state again.
        console.error('Could not save the drive:', error && error.message);
        this.state.dirty = false;
        this.state.etag = null;
        try {
          await this.state.sync({ force: true });
        } catch (reloadError) {
          this.state.reset();
        }
        this.reloaded();
        if (response.body) response.body.cancel().catch(() => {});
        return new Response(
          JSON.stringify({
            error: isPreconditionFailure(error, this.state.sdk)
              ? 'Deluxe Drive was busy with another change. Try again.'
              : 'Deluxe Drive could not save that. Try again in a moment.',
            code: 'retry',
          }),
          { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '1' } }
        );
      }
      return response;
    });
  }
}
