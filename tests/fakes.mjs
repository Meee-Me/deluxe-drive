import { DatabaseSync } from 'node:sqlite';

export class NodeSql {
  constructor() { this.db = new DatabaseSync(':memory:'); }
  exec(query, ...params) {
    // The Durable Object takes ArrayBuffer for BLOBs; node:sqlite wants bytes.
    params = params.map((p) => (p instanceof ArrayBuffer ? new Uint8Array(p) : p));
    const stmt = this.db.prepare(query);
    if (/^\s*(select|with)/i.test(query)) {
      const rows = stmt.all(...params);
      return { toArray: () => rows };
    }
    stmt.run(...params);
    return { toArray: () => [] };
  }
}

export class FakeR2 {
  constructor() { this.m = new Map(); }
  async put(key, body, opts) {
    let buf;
    if (body && typeof body.getReader === 'function') buf = new Uint8Array(await new Response(body).arrayBuffer());
    else buf = new Uint8Array(body);
    this.m.set(key, { buf, type: opts?.httpMetadata?.contentType });
    return { size: buf.length };
  }
  async get(key, opts) {
    const e = this.m.get(key); if (!e) return null;
    let b = e.buf;
    if (opts?.range) b = b.slice(opts.range.offset, opts.range.offset + opts.range.length);
    return { body: new Response(b).body, size: b.length };
  }
  async delete(keys) { for (const k of [].concat(keys)) this.m.delete(k); }
  async list({ prefix = '' } = {}) {
    const objects = [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key }));
    return { objects, truncated: false };
  }
}


// Stands in for the @vercel/blob SDK (2.x): put / get / del with ETags,
// ifMatch, ifNoneMatch (304), Range reads and random suffixes, all in memory.
export class FakeBlobSdk {
  constructor() {
    this.m = new Map();
    this.n = 0;
    this.ops = { put: 0, get: 0, del: 0, head: 0 };
    const sdk = this;
    this.BlobPreconditionFailedError = class extends Error { constructor() { super('Vercel Blob: Precondition failed: ETag mismatch.'); } };
    this.BlobNotFoundError = class extends Error { constructor() { super('Vercel Blob: The requested blob does not exist'); } };
    this.put = async (pathname, body, o = {}) => {
      sdk.ops.put++;
      if (o.access !== 'public' && o.access !== 'private') throw new Error('Vercel Blob: access must be "private" or "public"');
      const path = o.addRandomSuffix ? `${pathname}-${(++sdk.n).toString(36)}${Math.random().toString(36).slice(2, 8)}` : pathname;
      const old = sdk.m.get(path);
      if (o.ifMatch !== undefined) { if (!old || old.etag !== o.ifMatch) throw new sdk.BlobPreconditionFailedError(); }
      else if (old && !o.allowOverwrite) throw new Error('Vercel Blob: This blob already exists');
      let bytes;
      if (typeof body === 'string') bytes = Buffer.from(body);
      else if (body && typeof body.getReader === 'function') bytes = Buffer.from(await new Response(body).arrayBuffer());
      else bytes = Buffer.from(body);
      const etag = `e${++sdk.n}`; // the API's form (put / head)
      sdk.m.set(path, { bytes, etag, contentType: o.contentType });
      return { pathname: path, url: `https://fake.blob/${path}`, etag };
    };
    this.get = async (pathname, o = {}) => {
      sdk.ops.get++;
      const e = sdk.m.get(pathname);
      if (!e) return null;
      // The real get() reports the ETag response header, which is not the
      // API's form that ifMatch takes: model that difference here.
      const header = `W/"${e.etag}"`;
      if (o.ifNoneMatch && o.ifNoneMatch === header) return { statusCode: 304, stream: null, blob: { etag: header, pathname } };
      let b = e.bytes;
      const range = o.headers && (o.headers.Range || o.headers.range);
      const m = range && /bytes=(\d+)-(\d+)/.exec(range);
      if (m) b = b.subarray(Number(m[1]), Number(m[2]) + 1);
      return { statusCode: 200, stream: new Response(b).body, blob: { etag: header, pathname, size: b.length } };
    };
    this.head = async (pathname) => {
      sdk.ops.head++;
      const e = sdk.m.get(pathname);
      if (!e) throw new sdk.BlobNotFoundError();
      return { pathname, etag: e.etag, size: e.bytes.length, contentType: e.contentType };
    };
    this.del = async (paths) => { sdk.ops.del++; for (const p of [].concat(paths)) sdk.m.delete(p); };
  }
}
