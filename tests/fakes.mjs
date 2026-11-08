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

