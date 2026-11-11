// Runs the Worker's server code in Node: node:sqlite stands in for the Durable
// Object's SQL, a Map stands in for R2, and a small fake stands in for Deluxe
// Main (which owns the accounts). Run: node tests/worker.test.mjs
import assert from 'node:assert/strict';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { HubCore } from '../worker/hub.js';
import { NodeSql, FakeR2 } from './fakes.mjs';

const origin = 'https://drive.test';
// STORE=r2 runs against a fake R2 bucket; the default keeps files in SQLite.
const useR2 = process.env.STORE === 'r2';
const files = new FakeR2();
const sqlAdapter = new NodeSql();

// Deluxe Main, as far as the drive can tell: a key belongs to an account and an app.
const keys = new Map([
  ['k_drive', { user: { id: 'u_a', name: 'Shivad' }, app: 'drive' }],
  ['k_main', { user: { id: 'u_a', name: 'Shivad' }, app: 'main' }],
  ['k_docs', { user: { id: 'u_a', name: 'Shivad' }, app: 'docs' }],
  ['k_translate', { user: { id: 'u_a', name: 'Shivad' }, app: 'translate' }],
  ['k_other', { user: { id: 'u_b', name: 'Other' }, app: 'drive' }],
  ['k_convert', { user: { id: 'u_a', name: 'Shivad' }, app: 'convert' }],
]);
let mainCalls = 0;
let mainDown = false;
const verify = async (token) => {
  mainCalls += 1;
  if (mainDown) throw new Error('offline');
  const who = keys.get(token);
  return new Response(JSON.stringify(who || { error: 'no' }), { status: who ? 200 : 401 });
};
const hub = new HubCore(sqlAdapter, useR2 ? { FILES: files } : {}, { verify });
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
  return hub.handle(new Request(origin + path, { method, headers: h, body: payload }));
}
const j = async (res) => res.json();
const derive = (pw, saltHex) => pbkdf2Sync(pw, Buffer.from(saltHex, 'hex'), 120000, 32, 'sha256').toString('hex');

let n = 0;
const ok = (name) => console.log(`ok ${++n} ${name}`);

let r = await call('GET', '/api/health');
const health = await j(r);
assert.equal(health.server, true); assert.equal(health.accounts, 'deluxe-main'); assert.equal(health.files, useR2 ? 'r2' : 'sqlite');
ok('health');

// no accounts are made here
const salt = randomBytes(16).toString('hex');
const hash = derive('hunter2', salt);
for (const [m, p] of [['POST', '/api/accounts'], ['POST', '/api/auth/session'], ['POST', '/api/link'], ['POST', '/api/link/redeem'], ['DELETE', '/api/accounts/u_a']]) {
  assert.equal((await call(m, p, { body: { name: 'New', salt, hash } })).status, 410, p);
}
ok('making or changing accounts here is gone (410)');

// keys come from Deluxe Main
assert.equal((await call('GET', '/api/auth/me')).status, 401);
assert.equal((await call('GET', '/api/auth/me', { token: 'nope' })).status, 401);
assert.equal((await j(await call('GET', '/api/auth/me', { token: 'k_drive' }))).user.name, 'Shivad');
const before = mainCalls;
await call('GET', '/api/auth/me', { token: 'k_drive' });
assert.equal(mainCalls, before, 'answers are cached');
assert.equal((await call('GET', '/api/db/usage', { token: 'k_translate' })).status, 403, 'other websites cannot use the drive');
mainDown = true;
assert.equal((await call('GET', '/api/auth/me', { token: 'k_unknown' })).status, 503);
mainDown = false;
ok('every key is checked with Deluxe Main');

const T = 'k_drive';
const bytes = new Uint8Array(1000).map((_, i) => i % 251);
r = await call('PUT', '/api/db/blobs/f_1', { token: T, raw: bytes, headers: { 'Content-Type': 'application/pdf', 'X-Deluxe-Mime': 'application/pdf', 'X-Deluxe-Name': encodeURIComponent('Quarterly Report ü.pdf'), 'Content-Length': String(bytes.length) } });
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
assert.equal(r.status, 201); assert.equal((await j(r)).size, 0);
ok('file upload, download, ranges, empty file');

const big = new Uint8Array(2.5 * 1024 * 1024).map((_, i) => (i * 7 + (i >> 10)) % 256);
r = await call('PUT', '/api/db/blobs/big', { token: T, raw: big, headers: { 'Content-Length': String(big.length) } });
assert.equal((await j(r)).size, big.length);
r = await call('GET', '/api/db/blobs/big', { token: T });
assert.deepEqual(new Uint8Array(await r.arrayBuffer()), big);
const lo = 1024 * 1024 - 10;
r = await call('GET', '/api/db/blobs/big', { token: T, headers: { Range: `bytes=${lo}-${lo + 30}` } });
assert.deepEqual(new Uint8Array(await r.arrayBuffer()), big.slice(lo, lo + 31));
await call('PUT', '/api/db/blobs/big', { token: T, raw: new Uint8Array(10).fill(9), headers: { 'Content-Length': '10' } });
r = await call('GET', '/api/db/blobs/big', { token: T });
assert.deepEqual(new Uint8Array(await r.arrayBuffer()), new Uint8Array(10).fill(9));
if (!useR2) assert.equal(sqlAdapter.db.prepare('SELECT COUNT(*) AS c FROM chunks WHERE key LIKE ?').get('%/big').c, 1);
await call('DELETE', '/api/db/blobs/big', { token: T });
ok('multi-piece file, boundary range, overwrite');

// share links
r = await call('POST', '/api/files/f_1/share', { token: T, body: { name: 'Report.pdf' } });
const share = await j(r);
assert.match(share.url, /^https:\/\/drive\.test\/s\/[0-9a-f]{32}$/);
assert.equal((await j(await call('POST', '/api/files/f_1/share', { token: T }))).token, share.token);
r = await call('GET', `/s/${share.token}`);
assert.equal(r.status, 200); assert.equal((await r.arrayBuffer()).byteLength, 1000);
assert.match(r.headers.get('content-disposition'), /Report\.pdf/);
assert.equal((await call('POST', '/api/files/nothere/share', { token: T })).status, 404);
assert.equal((await j(await call('GET', '/api/files/shares', { token: T }))).shares.length, 1);
assert.equal((await call('GET', '/s/' + 'a'.repeat(32))).status, 404);
ok('share links');

// Deluxe Docs reads, and only reads
const V = 'k_docs';
assert.equal((await call('GET', '/api/db/blobs/f_1', { token: V })).status, 200);
assert.equal((await call('PUT', '/api/db/blobs/f_1', { token: V, raw: new Uint8Array(3), headers: { 'Content-Length': '3' } })).status, 403);
assert.equal((await call('DELETE', '/api/db/blobs/f_1', { token: V })).status, 403);
assert.equal((await call('POST', '/api/files/f_1/share', { token: V })).status, 403);
assert.equal((await call('POST', '/api/db/clear', { token: V })).status, 403);
ok('docs key reads files only');

// Deluxe Convert adds new files, and nothing else
assert.equal((await call('PUT', '/api/db/blobs/conv_1', { token: 'k_convert', raw: new Uint8Array(3), headers: { 'Content-Length': '3' } })).status, 201);
assert.equal((await call('PUT', '/api/db/blobs/conv_1', { token: 'k_convert', raw: new Uint8Array(4), headers: { 'Content-Length': '4' } })).status, 409, 'no overwriting');
assert.equal((await call('PUT', '/api/db/blobs/f_1', { token: 'k_convert', raw: new Uint8Array(4), headers: { 'Content-Length': '4' } })).status, 409);
assert.equal((await call('GET', '/api/db/blobs/conv_1', { token: 'k_convert' })).status, 403, 'no reading');
assert.equal((await call('DELETE', '/api/db/blobs/conv_1', { token: 'k_convert' })).status, 403, 'no deleting');
assert.equal((await call('GET', '/api/db/blobs/conv_1', { token: T })).status, 200, 'the owner sees it');
await call('DELETE', '/api/db/blobs/conv_1', { token: T });
ok('convert key only adds new files');

// accounts are isolated
assert.equal((await call('GET', '/api/db/blobs/f_1', { token: 'k_other' })).status, 404);
assert.equal((await j(await call('GET', '/api/db/usage', { token: T }))).files, 2);
ok('accounts are isolated');

// an old Deluxe Drive account moves to Deluxe Main, keeping its id and files
const oldSalt = randomBytes(16).toString('hex');
const oldHash = derive('old-pass', oldSalt);
sqlAdapter.exec(`INSERT INTO accounts (id, name, name_lc, salt, hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, 'u_b', 'Other', 'other', oldSalt, oldHash, 1, 1);
sqlAdapter.exec(`INSERT INTO nodes (account_id, id, json) VALUES (?, ?, ?)`, 'u_b', 'n1', JSON.stringify({ id: 'n1', name: 'a.txt', type: 'file' }));
sqlAdapter.exec(`INSERT INTO settings (account_id, key, json) VALUES (?, ?, ?)`, 'u_b', 'theme', JSON.stringify('dark'));
await call('PUT', '/api/db/blobs/n1', { token: 'k_other', raw: new Uint8Array(4), headers: { 'Content-Length': '4' } });
assert.equal((await j(await call('POST', '/api/accounts/find', { body: { name: 'other' } }))).salt, oldSalt);
assert.equal((await j(await call('POST', '/api/legacy/exists', { body: { name: 'OTHER' } }))).exists, true);
assert.equal((await call('POST', '/api/legacy/claim', { body: { name: 'Other', hash: derive('nope', oldSalt) } })).status, 401);
r = await call('POST', '/api/legacy/claim', { body: { name: 'Other', hash: oldHash } });
assert.deepEqual(await j(r), { id: 'u_b', name: 'Other', salt: oldSalt });
assert.equal((await call('POST', '/api/legacy/claim', { body: { name: 'Other', hash: oldHash } })).status, 401, 'only once');
assert.equal((await j(await call('POST', '/api/legacy/exists', { body: { name: 'Other' } }))).exists, false);
const old = await j(await call('GET', '/api/legacy/data', { token: 'k_other' }));
assert.equal(old.nodes[0].name, 'a.txt'); assert.deepEqual(old.settings, [{ key: 'theme', value: 'dark' }]);
await call('POST', '/api/legacy/data/done', { token: 'k_other' });
assert.equal((await j(await call('GET', '/api/legacy/data', { token: 'k_other' }))).nodes.length, 0);
assert.equal((await call('GET', '/api/db/blobs/n1', { token: 'k_other' })).status, 200, 'files stay');
ok('old accounts move to Deluxe Main once, files stay');

for (let i = 0; i < 8; i++) await call('POST', '/api/legacy/claim', { body: { name: 'Ghost', hash: 'c'.repeat(64) } });
assert.equal((await call('POST', '/api/legacy/claim', { body: { name: 'Ghost', hash: 'c'.repeat(64) } })).status, 429);
ok('guessing old passwords is throttled');

// deleting a file's contents ends its share link; clearing empties the account
assert.equal((await call('DELETE', '/api/db/blobs/f_1', { token: T })).status, 200);
assert.equal((await call('GET', `/s/${share.token}`)).status, 404);
assert.equal(hasBlob('b/u_a/f_1'), false);
await call('PUT', '/api/db/blobs/g_1', { token: T, raw: new Uint8Array(5), headers: { 'Content-Length': '5' } });
assert.ok(hasBlob('b/u_a/g_1'));
assert.equal((await call('POST', '/api/db/clear', { token: 'k_main' })).status, 200, 'Deluxe Main empties a deleted account');
assert.equal(hasBlob('b/u_a/g_1'), false);
assert.equal(hasBlob('b/u_b/n1'), true);
ok('deleting files and clearing an account');

assert.equal((await call('GET', '/api/nope')).status, 404);
assert.equal((await call('GET', '/api/db/nodes', { token: T })).status, 404, 'the file list lives in Deluxe Main');
ok('unknown routes');

console.log(`\nall ${n} groups passed`);
