// Runs the Worker's server code in Node: node:sqlite stands in for the Durable
// Object's SQL, and a Map stands in for R2. Run: node tests/worker.test.mjs
import assert from 'node:assert/strict';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { HubCore } from '../worker/hub.js';
import { NodeSql, FakeR2 } from './fakes.mjs';

const origin = 'https://drive.test';
// STORE=r2 runs against a fake R2 bucket; the default keeps files in SQLite.
const useR2 = process.env.STORE === 'r2';
const files = new FakeR2();
const sqlAdapter = new NodeSql();
const hub = new HubCore(sqlAdapter, useR2 ? { FILES: files } : {});
const hasBlob = (key) => (useR2
  ? files.m.has(key)
  : sqlAdapter.db.prepare('SELECT COUNT(*) AS c FROM chunks WHERE key = ?').get(key).c > 0);
console.log('file storage:', useR2 ? 'r2 (fake)' : 'sqlite');

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
assert.equal(r.status, 200); const health = await j(r); assert.equal(health.server, true); assert.equal(health.files, useR2 ? 'r2' : 'sqlite'); ok('health');

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
if (!useR2) assert.equal(sqlAdapter.db.prepare('SELECT COUNT(*) AS c FROM chunks WHERE key LIKE ?').get('%/big').c, 1);
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
sqlAdapter.db.prepare('UPDATE link_codes SET expires_at = ?').run(Date.now() - 1);
assert.equal((await call('POST', '/api/link/redeem', { body: { linkId: l3.linkId } })).status, 404);
ok('link ids expire');

const V = redeemed.token;
assert.equal((await j(await call('GET', '/api/auth/me', { token: V }))).user.name, 'Shivad');
assert.equal((await j(await call('GET', '/api/db/nodes', { token: V }))).nodes.length, 2);
r = await call('GET', '/api/db/blobs/f_1', { token: V });
assert.equal((await r.arrayBuffer()).byteLength, 1000); ok('docs key can list and read files');

// viewer token is read-only and cannot reach anything else
// Docs may save over a file it opened, and add new files, nothing else
r = await call('PUT', '/api/docs/files/f_1', { token: V, raw: new Uint8Array([1, 2, 3]), headers: { 'Content-Length': '3', 'X-Deluxe-Mime': 'application/pdf' } });
assert.equal(r.status, 200);
let savedNode = (await j(r)).node;
assert.equal(savedNode.size, 3); assert.equal(savedNode.name, node.name); assert.ok(savedNode.updatedAt > 1);
assert.deepEqual(new Uint8Array(await (await call('GET', '/api/db/blobs/f_1', { token: T })).arrayBuffer()), new Uint8Array([1, 2, 3]));
assert.equal((await call('PUT', '/api/docs/files/d_1', { token: V, raw: new Uint8Array(1), headers: { 'Content-Length': '1' } })).status, 404);
assert.equal((await call('PUT', '/api/docs/files/nope', { token: V, raw: new Uint8Array(1), headers: { 'Content-Length': '1' } })).status, 404);
r = await call('POST', '/api/docs/files', { token: V, raw: new Uint8Array(4), headers: { 'Content-Length': '4', 'X-Deluxe-Name': encodeURIComponent(node.name), 'X-Deluxe-Mime': 'application/pdf' } });
assert.equal(r.status, 201);
const added = (await j(r)).node;
assert.equal(added.name, 'Quarterly Report ü (2).pdf'); assert.equal(added.parentId, null); assert.equal(added.size, 4);
r = await call('POST', '/api/docs/files', { token: V, raw: new Uint8Array(2), headers: { 'Content-Length': '2', 'X-Deluxe-Name': 'inside.txt', 'X-Deluxe-Parent': 'd_1' } });
assert.equal((await j(r)).node.parentId, 'd_1');
r = await call('POST', '/api/docs/files', { token: V, raw: new Uint8Array(2), headers: { 'Content-Length': '2', 'X-Deluxe-Name': encodeURIComponent('../a/b.txt'), 'X-Deluxe-Parent': 'f_1' } });
const odd = (await j(r)).node; assert.equal(odd.parentId, null); assert.ok(!odd.name.includes('/'));
await call('DELETE', `/api/db/nodes/${added.id}`, { token: T });
await call('DELETE', `/api/db/nodes/${odd.id}`, { token: T });
for (const n of (await j(await call('GET', '/api/db/nodes', { token: T }))).nodes) if (n.name === 'inside.txt') await call('DELETE', `/api/db/nodes/${n.id}`, { token: T });
// put the original bytes back for the tests below
await call('PUT', '/api/db/blobs/f_1', { token: T, raw: bytes, headers: { 'Content-Length': String(bytes.length) } });
ok('docs key can save over a file and add new files');

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

// delete file removes blob and share
assert.equal((await call('DELETE', '/api/db/nodes/f_1', { token: T })).status, 200);
assert.equal((await call('GET', `/s/${share.token}`)).status, 404);
assert.equal(hasBlob(`b/${acct.user.id}/f_1`), false); ok('deleting a file removes its data and share link');

// clear + delete account
await call('PUT', '/api/db/blobs/g_1', { token: T, raw: new Uint8Array(5), headers: { 'Content-Length': '5' } });
assert.ok(hasBlob(`b/${acct.user.id}/g_1`));
assert.equal((await call('DELETE', `/api/accounts/${acct.user.id}`, { token: T })).status, 200);
assert.equal(hasBlob(`b/${acct.user.id}/g_1`), false);
assert.equal((await call('GET', '/api/auth/me', { token: T })).status, 401); ok('deleting an account removes everything');

// unknown routes
assert.equal((await call('GET', '/api/nope')).status, 404);
assert.equal((await call('GET', '/oauth/authorize')).status, 404);
assert.equal((await call('GET', '/connect/abc')).status, 404); ok('unknown routes');

console.log(`\nall ${n} groups passed`);
