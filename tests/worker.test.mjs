// Runs the server code (worker/hub.js) in Node: node:sqlite stands in for the
// Durable Object's SQL, and a Map stands in for R2. Run: node tests/worker.test.mjs
// STORE=r2 keeps files in a fake R2 bucket. STORE=blob runs it the way the
// Vercel Function does by default (api/_blob.mjs, on a fake Vercel Blob).
// PG_URL=postgres://... runs it on Postgres through api/_pg.mjs.
import assert from 'node:assert/strict';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { HubCore } from '../worker/hub.js';
import { NodeSql, FakeR2, FakeBlobSdk } from './fakes.mjs';

const origin = 'https://drive.test';
// STORE=r2 runs against a fake R2 bucket; the default keeps files in SQLite.
const useR2 = process.env.STORE === 'r2';
const useBlob = process.env.STORE === 'blob';
const blobSdk = new FakeBlobSdk();
const pgUrl = process.env.PG_URL || '';
const files = new FakeR2();
let sqlAdapter;
if (pgUrl) {
  const { PgSql } = await import('../api/_pg.mjs');
  sqlAdapter = new PgSql(pgUrl);
  for (const t of ['meta', 'accounts', 'nodes', 'settings', 'blobs', 'shares', 'sessions', 'link_codes', 'chunks']) await sqlAdapter.exec(`DROP TABLE IF EXISTS ${t}`);
} else sqlAdapter = new NodeSql();
let hub;
let blobBackend = null;
if (useBlob) {
  const { BlobBackend } = await import('../api/_blob.mjs');
  blobBackend = new BlobBackend(blobSdk, (sql, store) => new HubCore(sql, { MAX_REQUEST_BYTES: 4 * 1024 * 1024, FILE_STORE: store }));
  sqlAdapter = blobBackend.state;
  hub = blobBackend;
} else {
  hub = new HubCore(sqlAdapter, useR2 ? { FILES: files } : { MAX_REQUEST_BYTES: 4 * 1024 * 1024 });
}
const q = async (query, ...params) => (await sqlAdapter.exec(query, ...params)).toArray();
const hasBlob = async (key) => (useR2
  ? files.m.has(key)
  : useBlob
    ? q('SELECT COUNT(*) AS c FROM blob_parts WHERE key = ?', key).then((r) => Number(r[0].c) > 0).catch(() => false)
    : Number((await q('SELECT COUNT(*) AS c FROM chunks WHERE key = ?', key))[0].c) > 0);
console.log('file storage:', useR2 ? 'r2 (fake)' : useBlob ? 'vercel blob (fake)' : pgUrl ? 'postgres' : 'sqlite');

async function call(method, path, { token, body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const req = new Request(origin + path, { method, headers: h, body: payload });
  return hub.handle(req);
}
const j = async (res) => res.json();
const derive = (pw, saltHex) => pbkdf2Sync(pw, Buffer.from(saltHex, 'hex'), 120000, 32, 'sha256').toString('hex');

let n = 0;
const ok = (name) => console.log(`ok ${++n} ${name}`);

// health
let r = await call('GET', '/api/health');
assert.equal(r.status, 200); const health = await j(r); assert.equal(health.server, true); assert.equal(health.files, useR2 ? 'r2' : useBlob ? 'vercel-blob' : 'sqlite'); ok('health');

// account
const salt = randomBytes(16).toString('hex');
const hash = derive('hunter2', salt);
r = await call('POST', '/api/accounts', { body: { name: 'Shivad', salt, hash } });
assert.equal(r.status, 201);
let acct = await j(r);
assert.ok(acct.token && acct.user.id);
r = await call('POST', '/api/accounts', { body: { name: 'shivad', salt, hash } });
assert.equal(r.status, 409); ok('create account + duplicate name rejected');

r = await call('POST', '/api/accounts/find', { body: { name: 'Shivad' } });
const found = await j(r);
assert.equal(found.salt, salt); assert.equal(found.id, acct.user.id);
const f1 = await j(await call('POST', '/api/accounts/find', { body: { name: 'Nobody' } }));
const f2 = await j(await call('POST', '/api/accounts/find', { body: { name: 'nobody' } }));
assert.equal(f1.salt, f2.salt); assert.ok(f1.salt.length === 32); ok('find: unknown name gets a stable fake record');

// sign in
r = await call('POST', '/api/auth/session', { body: { userId: acct.user.id, hash: 'f'.repeat(64) } });
assert.equal(r.status, 401);
r = await call('POST', '/api/auth/session', { body: { userId: acct.user.id, hash } });
assert.equal(r.status, 200); const sess = await j(r); assert.ok(sess.token);
r = await call('GET', '/api/auth/me', { token: sess.token });
assert.equal((await j(r)).user.name, 'Shivad');
assert.equal((await call('GET', '/api/auth/me')).status, 401); ok('sign in, me, 401 without token');

const T = sess.token;

// nodes + settings
const node = { id: 'f_1', type: 'file', name: 'Quarterly Report ü.pdf', parentId: null, size: 10, mime: 'application/pdf', updatedAt: 1 };
r = await call('PUT', '/api/db/nodes/f_1', { token: T, body: node }); assert.equal(r.status, 200);
r = await call('POST', '/api/db/nodes', { token: T, body: { nodes: [{ id: 'd_1', type: 'folder', name: 'Docs' }] } });
assert.equal((await j(r)).count, 1);
const list = (await j(await call('GET', '/api/db/nodes', { token: T }))).nodes;
assert.equal(list.length, 2);
assert.equal((await j(await call('GET', '/api/db/nodes/f_1', { token: T }))).node.name, node.name);
assert.equal((await call('PUT', '/api/db/nodes/bad%20id!', { token: T, body: {} })).status, 400); // ids are validated
await call('PUT', '/api/db/settings/theme', { token: T, body: { value: 'dark' } });
assert.equal((await j(await call('GET', '/api/db/settings/theme', { token: T }))).value, 'dark');
assert.equal((await call('GET', '/api/db/settings/nope', { token: T })).status, 404); ok('nodes and settings');

// blobs
const bytes = new Uint8Array(1000).map((_, i) => i % 251);
r = await call('PUT', '/api/db/blobs/f_1', { token: T, raw: bytes, headers: { 'Content-Type': 'application/pdf', 'X-Deluxe-Mime': 'application/pdf', 'Content-Length': String(bytes.length) } });
assert.equal(r.status, 201); assert.equal((await j(r)).size, 1000);
r = await call('GET', '/api/db/blobs/f_1', { token: T });
assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/pdf');
assert.match(r.headers.get('content-disposition'), /filename\*=UTF-8''Quarterly%20Report%20%C3%BC\.pdf/);
assert.deepEqual(new Uint8Array(await r.arrayBuffer()), bytes);
r = await call('GET', '/api/db/blobs/f_1', { token: T, headers: { Range: 'bytes=10-19' } });
assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), 'bytes 10-19/1000');
assert.deepEqual(new Uint8Array(await r.arrayBuffer()), bytes.slice(10, 20));
r = await call('GET', '/api/db/blobs/f_1', { token: T, headers: { Range: 'bytes=-5' } });
assert.deepEqual(new Uint8Array(await r.arrayBuffer()), bytes.slice(995));
r = await call('GET', '/api/db/blobs/f_1', { token: T, headers: { Range: 'bytes=5000-' } });
assert.equal(r.status, 416);
r = await call('PUT', '/api/db/blobs/empty', { token: T, raw: new Uint8Array(0), headers: { 'Content-Length': '0' } });
assert.equal(r.status, 201); assert.equal((await j(r)).size, 0); ok('blob upload, download, ranges, empty file');

// a file bigger than one 1 MB piece, read whole and across a piece boundary
const big = new Uint8Array(2.5 * 1024 * 1024).map((_, i) => (i * 7 + (i >> 10)) % 256);
r = await call('PUT', '/api/db/blobs/big', { token: T, raw: big, headers: { 'Content-Length': String(big.length) } });
assert.equal(r.status, 201); assert.equal((await j(r)).size, big.length);
r = await call('GET', '/api/db/blobs/big', { token: T });
assert.deepEqual(new Uint8Array(await r.arrayBuffer()), big);
const lo = 1024 * 1024 - 10;
r = await call('GET', '/api/db/blobs/big', { token: T, headers: { Range: `bytes=${lo}-${lo + 30}` } });
assert.equal(r.status, 206); assert.deepEqual(new Uint8Array(await r.arrayBuffer()), big.slice(lo, lo + 31));
r = await call('GET', '/api/db/blobs/big', { token: T, headers: { Range: `bytes=${big.length - 5}-` } });
assert.deepEqual(new Uint8Array(await r.arrayBuffer()), big.slice(big.length - 5));
// overwriting with something smaller leaves no stale pieces behind
await call('PUT', '/api/db/blobs/big', { token: T, raw: new Uint8Array(10).fill(9), headers: { 'Content-Length': '10' } });
r = await call('GET', '/api/db/blobs/big', { token: T });
assert.deepEqual(new Uint8Array(await r.arrayBuffer()), new Uint8Array(10).fill(9));
if (!useR2 && !useBlob) assert.equal(Number((await q('SELECT COUNT(*) AS c FROM chunks WHERE key LIKE ?', '%/big'))[0].c), 1);
await call('DELETE', '/api/db/blobs/big', { token: T });
ok('multi-piece file, boundary range, overwrite');

// share
r = await call('POST', '/api/files/f_1/share', { token: T });
const share = await j(r);
assert.match(share.url, /^https:\/\/drive\.test\/s\/[0-9a-f]{32}$/);
const again = await j(await call('POST', '/api/files/f_1/share', { token: T }));
assert.equal(again.token, share.token);
r = await call('GET', `/s/${share.token}`);
assert.equal(r.status, 200); assert.equal((await r.arrayBuffer()).byteLength, 1000);
assert.equal((await call('POST', '/api/files/d_1/share', { token: T })).status, 400);
assert.equal((await j(await call('GET', '/api/files/shares', { token: T }))).shares.length, 1);
assert.equal((await call('GET', '/s/' + 'a'.repeat(32))).status, 404); ok('share links');

// link ids for Deluxe Docs
r = await call('POST', '/api/link', { token: T });
assert.equal(r.status, 201);
const l1 = await j(r);
assert.match(l1.linkId, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
assert.equal(l1.expiresIn, 60);
const l2 = await j(await call('POST', '/api/link', { token: T }));
assert.notEqual(l2.linkId, l1.linkId);
assert.equal((await call('POST', '/api/link')).status, 401);
// a newer id ends the older one
assert.equal((await call('POST', '/api/link/redeem', { body: { linkId: l1.linkId } })).status, 404);
// pasted with spaces, lower case and no dashes still works
const pasted = ` ${l2.linkId.replace(/-/g, '').toLowerCase()} `;
r = await call('POST', '/api/link/redeem', { body: { linkId: pasted } });
assert.equal(r.status, 200);
const redeemed = await j(r);
assert.equal(redeemed.user.name, 'Shivad'); assert.ok(redeemed.token); assert.ok(redeemed.expiresIn > 86400);
// one use only
assert.equal((await call('POST', '/api/link/redeem', { body: { linkId: l2.linkId } })).status, 404);
assert.equal((await call('POST', '/api/link/redeem', { body: { linkId: 'nonsense' } })).status, 404);
ok('link ids: new each time, one use, newest wins, forgiving paste');

// an id runs out after 60 seconds
const l3 = await j(await call('POST', '/api/link', { token: T }));
await q('UPDATE link_codes SET expires_at = ?', Date.now() - 1);
assert.equal((await call('POST', '/api/link/redeem', { body: { linkId: l3.linkId } })).status, 404);
ok('link ids expire');

const V = redeemed.token;
assert.equal((await j(await call('GET', '/api/auth/me', { token: V }))).user.name, 'Shivad');
assert.equal((await j(await call('GET', '/api/db/nodes', { token: V }))).nodes.length, 2);
r = await call('GET', '/api/db/blobs/f_1', { token: V });
assert.equal((await r.arrayBuffer()).byteLength, 1000); ok('docs key can list and read files');

// viewer token is read-only and cannot reach anything else
assert.equal((await call('PUT', '/api/db/nodes/f_1', { token: V, body: node })).status, 403);
assert.equal((await call('DELETE', '/api/db/nodes/f_1', { token: V })).status, 403);
assert.equal((await call('PUT', '/api/db/blobs/f_1', { token: V, raw: new Uint8Array(3), headers: { 'Content-Length': '3' } })).status, 403);
assert.equal((await call('GET', '/api/db/settings/theme', { token: V })).status, 403);
assert.equal((await call('POST', '/api/link', { token: V })).status, 403);
assert.equal((await call('POST', '/api/files/f_1/share', { token: V })).status, 403);
assert.equal((await call('POST', '/api/db/clear', { token: V })).status, 403);
assert.equal((await call('DELETE', `/api/accounts/${acct.user.id}`, { token: V })).status, 403);
assert.equal((await j(await call('GET', '/api/db/nodes', { token: T }))).nodes.length, 2); ok('docs key is read-only');

// disconnecting ends the key
const l4 = await j(await call('POST', '/api/link', { token: T }));
const V2 = (await j(await call('POST', '/api/link/redeem', { body: { linkId: l4.linkId } }))).token;
assert.equal((await call('DELETE', '/api/link/session', { token: V2 })).status, 200);
assert.equal((await call('GET', '/api/db/nodes', { token: V2 })).status, 401); ok('disconnecting ends the docs key');

// Deluxe Convert: its own link ids, a key that can only add files
const c1 = await j(await call('POST', '/api/link', { token: T, body: { app: 'deluxe-convert' } }));
assert.equal(c1.app, 'deluxe-convert');
const d1 = await j(await call('POST', '/api/link', { token: T })); // a docs id does not end the convert id
assert.equal((await call('POST', '/api/link', { token: T, body: { app: 'nope' } })).status, 400);
r = await call('POST', '/api/link/redeem', { body: { linkId: c1.linkId } }); // docs cannot use a convert id
assert.equal(r.status, 409); assert.equal((await j(r)).code, 'link-wrong-app');
r = await call('POST', '/api/link/redeem', { body: { linkId: d1.linkId, app: 'deluxe-convert' } });
assert.equal(r.status, 409);
r = await call('POST', '/api/link/redeem', { body: { linkId: c1.linkId, app: 'deluxe-convert' } });
assert.equal(r.status, 200); const conv = await j(r); assert.equal(conv.scope, 'drive.import'); assert.equal(conv.user.name, 'Shivad');
assert.equal((await call('POST', '/api/link/redeem', { body: { linkId: c1.linkId, app: 'deluxe-convert' } })).status, 404);
assert.equal((await call('POST', '/api/link/redeem', { body: { linkId: d1.linkId } })).status, 200); // docs id still good
ok('convert link ids are separate from docs link ids');

const C = conv.token;
const payload = new TextEncoder().encode('converted!');
const imp = async (name, extra = '') => call('POST', '/api/import' + extra, { token: C, raw: payload, headers: { 'Content-Type': 'text/plain', 'X-Deluxe-Name': encodeURIComponent(name), 'Content-Length': String(payload.length) } });
r = await imp('Report ü.txt');
assert.equal(r.status, 201); const im1 = await j(r);
{ const sh = await call('POST', `/api/import/${im1.file.id}/share`, { token: C }); assert.equal(sh.status, 200); assert.match((await j(sh)).share.url, /\/s\/[0-9a-f]+$/); }
assert.equal((await call('POST', '/api/import/f_1/share', { token: C })).status, 404); // only files Convert added
assert.equal(im1.file.name, 'Report ü.txt'); assert.equal(im1.file.size, payload.length); assert.equal(im1.folder, 'Deluxe Convert');
r = await imp('Report ü.txt', '?share=1');
const im2 = await j(r);
assert.equal(im2.file.name, 'Report ü (1).txt'); assert.match(im2.share.url, /\/s\/[0-9a-f]+$/);
assert.equal(await (await call('GET', new URL(im2.share.url).pathname)).text(), 'converted!');
r = await imp('../../evil');
assert.equal((await j(r)).file.name, '.._.._evil');
const after = (await j(await call('GET', '/api/db/nodes', { token: T }))).nodes;
const folders = after.filter((x) => x.type === 'folder' && x.name === 'Deluxe Convert');
assert.equal(folders.length, 1); assert.equal(folders[0].ownerId, acct.user.id);
const imported = after.filter((x) => x.parentId === folders[0].id);
assert.equal(imported.length, 3); assert.ok(imported.every((x) => x.ownerId === acct.user.id && x.type === 'file' && x.mime === 'text/plain'));
r = await call('GET', `/api/db/blobs/${im1.file.id}`, { token: T });
assert.equal(await r.text(), 'converted!'); ok('convert key adds files to a Deluxe Convert folder');

assert.equal((await call('GET', '/api/db/nodes', { token: C })).status, 403);
assert.equal((await call('GET', `/api/db/blobs/${im1.file.id}`, { token: C })).status, 403);
assert.equal((await call('PUT', '/api/db/nodes/f_1', { token: C, body: node })).status, 403);
assert.equal((await call('DELETE', `/api/db/nodes/${im1.file.id}`, { token: C })).status, 403);
assert.equal((await call('POST', '/api/link', { token: C, body: { app: 'deluxe-convert' } })).status, 403);
assert.equal((await call('GET', '/api/files/shares', { token: C })).status, 403);
assert.equal((await j(await call('GET', '/api/auth/me', { token: C }))).user.name, 'Shivad');
assert.equal((await call('POST', '/api/import', { token: V, raw: payload, headers: { 'Content-Length': String(payload.length) } })).status, 403); // docs key cannot add
assert.equal((await call('DELETE', '/api/link/session', { token: C })).status, 200);
assert.equal((await imp('x.txt')).status, 401); ok('convert key can only add files, and disconnect ends it');
// tidy up so later counts are unchanged
for (const x of [...imported, ...folders]) await call('DELETE', `/api/db/nodes/${x.id}`, { token: T });

// second account is isolated
const salt2 = randomBytes(16).toString('hex'); const hash2 = derive('pw2', salt2);
const other = await j(await call('POST', '/api/accounts', { body: { name: 'Other', salt: salt2, hash: hash2 } }));
assert.equal((await j(await call('GET', '/api/db/nodes', { token: other.token }))).nodes.length, 0);
assert.equal((await call('GET', '/api/db/blobs/f_1', { token: other.token })).status, 404);
assert.equal((await call('DELETE', `/api/accounts/${acct.user.id}`, { token: other.token })).status, 403); ok('accounts are isolated');

// password change, rename
const salt3 = randomBytes(16).toString('hex'); const hash3 = derive('new-pass', salt3);
assert.equal((await call('POST', `/api/accounts/${acct.user.id}/password`, { token: T, body: { currentHash: 'a'.repeat(64), salt: salt3, hash: hash3 } })).status, 401);
assert.equal((await call('POST', `/api/accounts/${acct.user.id}/password`, { token: T, body: { currentHash: hash, salt: salt3, hash: hash3 } })).status, 200);
assert.equal((await call('POST', '/api/auth/session', { body: { userId: acct.user.id, hash } })).status, 401);
assert.equal((await call('POST', '/api/auth/session', { body: { userId: acct.user.id, hash: hash3 } })).status, 200);
assert.equal((await call('PATCH', `/api/accounts/${acct.user.id}`, { token: T, body: { name: 'Other' } })).status, 409);
assert.equal((await j(await call('PATCH', `/api/accounts/${acct.user.id}`, { token: T, body: { name: 'Shivad S' } }))).user.name, 'Shivad S'); ok('password change and rename');

// throttle
for (let i = 0; i < 8; i++) await call('POST', '/api/auth/session', { body: { userId: other.user.id, hash: 'c'.repeat(64) } });
assert.equal((await call('POST', '/api/auth/session', { body: { userId: other.user.id, hash: hash2 } })).status, 429); ok('sign-in is throttled after repeated failures');

for (let i = 0; i < 8; i++) await call('POST', '/api/link/redeem', { body: { linkId: 'AAAA-BBBB-CCCC' }, headers: { 'cf-connecting-ip': '9.9.9.9' } });
assert.equal((await call('POST', '/api/link/redeem', { body: { linkId: 'AAAA-BBBB-CCCC' }, headers: { 'cf-connecting-ip': '9.9.9.9' } })).status, 429);
assert.equal((await call('POST', '/api/link/redeem', { body: { linkId: 'AAAA-BBBB-CCCC' }, headers: { 'cf-connecting-ip': '8.8.8.8' } })).status, 404); ok('guessing link ids is throttled per address');

// big files in pieces (a Vercel Function takes about 4.5 MB per request)
const health2 = await j(await call('GET', '/api/health'));
if (!useR2) {
  assert.equal(health2.limits.partBytes, 4 * 1024 * 1024);
  const MB = 1024 * 1024, total = 9 * MB + 123;
  const whole = new Uint8Array(total).map((_, i) => (i * 7) % 256);
  const piece = (from, to) => whole.slice(from, to);
  const put = (offset, bytes, last) => call('PUT', `/api/db/blobs/p_1?offset=${offset}${last ? '&last=1' : ''}`, { token: T, raw: bytes, headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) } });
  assert.equal((await put(0, piece(0, 4 * MB))).status, 202);
  assert.equal((await call('GET', '/api/db/blobs/p_1', { token: T })).status, 404); // not readable until the last piece
  assert.equal((await put(8 * MB, piece(8 * MB, total), true)).status, 409); // a gap is refused
  assert.equal((await put(4 * MB, piece(4 * MB, 8 * MB))).status, 202);
  assert.equal((await put(8 * MB, piece(8 * MB, total), true)).status, 201);
  r = await call('GET', '/api/db/blobs/p_1', { token: T });
  const back = new Uint8Array(await r.arrayBuffer());
  assert.equal(back.length, total); assert.ok(back.every((b, i) => b === whole[i]));
  r = await call('GET', '/api/db/blobs/p_1', { token: T, headers: { Range: `bytes=${4 * MB - 2}-${4 * MB + 1}` } });
  assert.equal(r.status, 206); assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [...whole.slice(4 * MB - 2, 4 * MB + 2)]);
  assert.equal((await put(1000, piece(0, 10))).status, 400); // pieces start on a 1 MB line
  await call('DELETE', '/api/db/blobs/p_1', { token: T });
  ok('big files upload in pieces and read back whole');

  // Deluxe Convert sends a big file in pieces too
  const cl = await j(await call('POST', '/api/link', { token: T, body: { app: 'deluxe-convert' } }));
  const CK = (await j(await call('POST', '/api/link/redeem', { body: { linkId: cl.linkId, app: 'deluxe-convert' } }))).token;
  const imp = (qs, bytes) => call('POST', '/api/import?' + qs, { token: CK, raw: bytes, headers: { 'Content-Type': 'video/mp4', 'X-Deluxe-Name': encodeURIComponent('clip.mp4'), 'Content-Length': String(bytes.length) } });
  r = await imp('offset=0', piece(0, 4 * MB)); assert.equal(r.status, 202);
  const up = (await j(r)).upload; assert.match(up, /^n_/);
  assert.equal((await imp(`offset=${4 * MB}&upload=f_1`, piece(4 * MB, 8 * MB))).status, 400); // cannot write into an existing file
  assert.equal((await imp(`offset=${4 * MB}&upload=${up}`, piece(4 * MB, 8 * MB))).status, 202);
  r = await imp(`offset=${8 * MB}&upload=${up}&last=1&share=1`, piece(8 * MB, total));
  assert.equal(r.status, 201); const big = await j(r);
  assert.equal(big.file.size, total); assert.equal(big.file.id, up); assert.ok(big.share.url);
  assert.equal((await imp(`offset=${4 * MB}&upload=${up}`, piece(4 * MB, 8 * MB))).status, 400); // finished uploads are closed
  const got = new Uint8Array(await (await call('GET', new URL(big.share.url).pathname)).arrayBuffer());
  assert.equal(got.length, total); assert.equal(got[total - 1], whole[total - 1]);
  for (const x of (await j(await call('GET', '/api/db/nodes', { token: T }))).nodes.filter((x) => x.id === up || x.name === 'Deluxe Convert')) await call('DELETE', `/api/db/nodes/${x.id}`, { token: T });
  await call('DELETE', '/api/link/session', { token: CK });
  ok('deluxe convert sends big files in pieces');
}

// delete file removes blob and share
assert.equal((await call('DELETE', '/api/db/nodes/f_1', { token: T })).status, 200);
assert.equal((await call('GET', `/s/${share.token}`)).status, 404);
assert.equal(await hasBlob(`b/${acct.user.id}/f_1`), false); ok('deleting a file removes its data and share link');

// clear + delete account
await call('PUT', '/api/db/blobs/g_1', { token: T, raw: new Uint8Array(5), headers: { 'Content-Length': '5' } });
assert.ok(await hasBlob(`b/${acct.user.id}/g_1`));
assert.equal((await call('DELETE', `/api/accounts/${acct.user.id}`, { token: T })).status, 200);
assert.equal(await hasBlob(`b/${acct.user.id}/g_1`), false);
assert.equal((await call('GET', '/api/auth/me', { token: T })).status, 401); ok('deleting an account removes everything');

// unknown routes
assert.equal((await call('GET', '/api/nope')).status, 404);
assert.equal((await call('GET', '/oauth/authorize')).status, 404);
assert.equal((await call('GET', '/connect/abc')).status, 404); ok('unknown routes');

if (pgUrl) await sqlAdapter.end();
console.log(`\nall ${n} groups passed`);
