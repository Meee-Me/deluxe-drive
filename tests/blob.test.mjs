// The Vercel Blob storage (api/_blob.mjs) across server instances: what one
// instance saves, a fresh one (a cold start) or a second one reads; two writes
// that would clash never overwrite each other. Run: node tests/blob.test.mjs
import assert from 'node:assert/strict';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { HubCore } from '../worker/hub.js';
import { BlobBackend } from '../api/_blob.mjs';
import { FakeBlobSdk } from './fakes.mjs';

const sdk = new FakeBlobSdk();
const make = () => new BlobBackend(sdk, (sql, files) => new HubCore(sql, { MAX_REQUEST_BYTES: 4 * 1024 * 1024, FILE_STORE: files }));
const call = (backend, method, path, { token, body, raw, headers = {} } = {}) => {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  return backend.handle(new Request('https://drive.test' + path, { method, headers: h, body: payload }));
};
const j = (r) => r.json();
let n = 0;
const ok = (name) => console.log(`ok ${++n} ${name}`);

// instance A: an account and a file
const A = make();
const salt = randomBytes(16).toString('hex');
const hash = pbkdf2Sync('pw', Buffer.from(salt, 'hex'), 1000, 32, 'sha256').toString('hex');
const acct = await j(await call(A, 'POST', '/api/accounts', { body: { name: 'Shivad', salt, hash } }));
assert.ok(acct.token);
await call(A, 'PUT', '/api/db/nodes/f_1', { token: acct.token, body: { id: 'f_1', type: 'file', name: 'a.txt', ownerId: acct.user.id } });
const bytes = new TextEncoder().encode('hello from blob');
assert.equal((await call(A, 'PUT', '/api/db/blobs/f_1', { token: acct.token, raw: bytes, headers: { 'Content-Length': String(bytes.length) } })).status, 201);
assert.ok(sdk.m.has('deluxe-drive/state.json'));
assert.ok([...sdk.m.keys()].some((k) => k.startsWith('deluxe-drive/files/b/')));
ok('instance A saves the drive to Vercel Blob');

// a cold start: a brand new instance reads everything back
const B = make();
assert.equal((await j(await call(B, 'GET', '/api/auth/me', { token: acct.token }))).user.name, 'Shivad');
assert.equal((await j(await call(B, 'GET', '/api/db/nodes', { token: acct.token }))).nodes[0].name, 'a.txt');
assert.equal(await (await call(B, 'GET', '/api/db/blobs/f_1', { token: acct.token })).text(), 'hello from blob');
ok('a new instance (cold start) reads the accounts, files and sessions back');

// B writes; A sees it on its next change (writes always check first)
await call(B, 'PUT', '/api/db/nodes/f_2', { token: acct.token, body: { id: 'f_2', type: 'file', name: 'b.txt', ownerId: acct.user.id } });
await call(A, 'PUT', '/api/db/nodes/f_3', { token: acct.token, body: { id: 'f_3', type: 'file', name: 'c.txt', ownerId: acct.user.id } });
const names = (await j(await call(B, 'GET', '/api/db/nodes', { token: acct.token }))).nodes.map((x) => x.name).sort();
await new Promise((r) => setTimeout(r, 3100)); // reads trust a recent load for 3 seconds
const namesA = (await j(await call(A, 'GET', '/api/db/nodes', { token: acct.token }))).nodes.map((x) => x.name).sort();
assert.deepEqual(namesA, ['a.txt', 'b.txt', 'c.txt']);
assert.deepEqual(names.length >= 2, true);
ok('two instances share one drive: neither loses the other\'s change');

// a clash: B's write lands between A's check and A's save -> A refuses, keeps B's
const realSync = A.state.sync.bind(A.state);
A.state.sync = async () => false; // A skips its check this once
await call(B, 'PUT', '/api/db/nodes/f_4', { token: acct.token, body: { id: 'f_4', type: 'file', name: 'd.txt', ownerId: acct.user.id } });
const clash = await call(A, 'PUT', '/api/db/nodes/f_5', { token: acct.token, body: { id: 'f_5', type: 'file', name: 'e.txt', ownerId: acct.user.id } });
A.state.sync = realSync;
assert.equal(clash.status, 503); assert.equal((await j(clash)).code, 'retry');
const C = make();
const after = (await j(await call(C, 'GET', '/api/db/nodes', { token: acct.token }))).nodes.map((x) => x.name).sort();
assert.deepEqual(after, ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
// trying again works
assert.equal((await call(A, 'PUT', '/api/db/nodes/f_5', { token: acct.token, body: { id: 'f_5', type: 'file', name: 'e.txt', ownerId: acct.user.id } })).status, 200);
assert.ok((await j(await call(make(), 'GET', '/api/db/nodes', { token: acct.token }))).nodes.some((x) => x.name === 'e.txt'));
ok('a clashing write is refused (503, try again) instead of overwriting');

// reads do not write: listing files costs no Blob writes
const before = sdk.ops.put;
for (let i = 0; i < 5; i++) await call(C, 'GET', '/api/db/nodes', { token: acct.token });
await call(C, 'GET', '/api/health');
assert.equal(sdk.ops.put, before);
ok('reading the drive makes no Blob writes');

// deleting a file removes its blob pieces
const pieces = () => [...sdk.m.keys()].filter((k) => k.startsWith(`deluxe-drive/files/b/${acct.user.id}/f_1/`)).length;
assert.equal(pieces(), 1);
await call(A, 'DELETE', '/api/db/nodes/f_1', { token: acct.token });
assert.equal(pieces(), 0);
ok('deleting a file deletes its pieces from Blob');

// a brand new store: health answers, nothing written until something changes
const empty = new FakeBlobSdk();
const E = new BlobBackend(empty, (sql, files) => new HubCore(sql, { FILE_STORE: files }));
assert.equal((await call(E, 'GET', '/api/health')).status, 200);
assert.equal(empty.ops.put, 0);
ok('a new, empty store works and stays empty until used');

console.log(`\nall ${n} groups passed`);
