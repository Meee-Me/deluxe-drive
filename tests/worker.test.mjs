// Runs the Worker's server code in Node: node:sqlite stands in for the Durable
// Object's SQL, and a Map stands in for R2. Run: node tests/worker.test.mjs
import assert from 'node:assert/strict';
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { HubCore } from '../worker/hub.js';
import { NodeSql, FakeR2 } from './fakes.mjs';

const origin = 'https://drive.test';
const DOCS = 'https://deluxe-docs.deluxelordd.workers.dev';
const files = new FakeR2();
const hub = new HubCore(new NodeSql(), { FILES: files, ALLOWED_DOCS_ORIGINS: DOCS });

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
const form = (obj) => ({ raw: new URLSearchParams(obj).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
const derive = (pw, saltHex) => pbkdf2Sync(pw, Buffer.from(saltHex, 'hex'), 120000, 32, 'sha256').toString('hex');
const b64u = (b) => Buffer.from(b).toString('base64url');

let n = 0;
const ok = (name) => console.log(`ok ${++n} ${name}`);

// health
let r = await call('GET', '/api/health');
assert.equal(r.status, 200); assert.equal((await j(r)).server, true); ok('health');

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

// docs link + connect
const link = await j(await call('GET', '/api/docs/link', { token: T }));
const link2 = await j(await call('GET', '/api/docs/link', { token: T }));
assert.equal(link.linkId, link2.linkId); assert.equal(link.link, `${origin}/connect/${link.linkId}`);
r = await call('GET', `/connect/${link.linkId}?redirect=${encodeURIComponent(DOCS + '/')}`);
assert.equal(r.status, 200);
const conn = await j(r);
assert.equal(conn.authorizeUrl, `${origin}/oauth/authorize`); assert.ok(conn.clientId.startsWith('dc_'));
assert.equal(conn.redirectUri, DOCS + '/'); // a site root keeps its slash
r = await call('GET', `/connect/${link.linkId}?redirect=${encodeURIComponent('https://evil.example/x')}`);
assert.equal(r.status, 403);
assert.equal((await call('GET', '/connect/' + 'b'.repeat(12))).status, 404);
assert.equal((await call('GET', `/connect/${link.linkId}`)).status, 200); ok('link id, connect, origin allow-list');

// OAuth code flow with PKCE
const verifier = b64u(randomBytes(32));
const challenge = b64u(createHash('sha256').update(verifier).digest());
const q = new URLSearchParams({ response_type: 'code', client_id: conn.clientId, redirect_uri: DOCS, scope: 'openid profile drive.read', state: 'st8', code_challenge: challenge, code_challenge_method: 'S256' });
r = await call('GET', `/oauth/authorize?${q}`);
assert.equal(r.status, 200); const loginHtml = await r.text();
assert.match(loginHtml, /Sign in to Deluxe Drive/); assert.match(loginHtml, /id="hs"/);
r = await call('POST', `/oauth/authorize?${q}`, form({ name: 'Shivad', hash: 'e'.repeat(64) }));
assert.equal(r.status, 401);
r = await call('POST', `/oauth/authorize?${q}`, form({ name: 'Shivad', hash }));
assert.equal(r.status, 200); const consent = await r.text();
const reqId = /name="request" value="([0-9a-f]+)"/.exec(consent)[1];
assert.match(consent, /deluxe-docs\.deluxelordd\.workers\.dev/);
r = await call('POST', `/oauth/authorize?${q}`, form({ request: reqId, decision: 'approve' }));
assert.equal(r.status, 302);
const back = new URL(r.headers.get('location'));
assert.equal(back.origin + back.pathname, DOCS + '/'); assert.equal(back.searchParams.get('state'), 'st8');
const code = back.searchParams.get('code');
// wrong verifier burns the code
r = await call('POST', '/oauth/token', form({ grant_type: 'authorization_code', code, client_id: conn.clientId, redirect_uri: DOCS, code_verifier: 'wrong' }));
assert.equal(r.status, 400);
r = await call('POST', '/oauth/token', form({ grant_type: 'authorization_code', code, client_id: conn.clientId, redirect_uri: DOCS, code_verifier: verifier }));
assert.equal(r.status, 400); ok('oauth: login, consent, code, wrong verifier burns it');

// do it again, properly
r = await call('POST', `/oauth/authorize?${q}`, form({ name: 'Shivad', hash }));
const reqId2 = /name="request" value="([0-9a-f]+)"/.exec(await r.text())[1];
r = await call('POST', `/oauth/authorize?${q}`, form({ request: reqId2, decision: 'approve' }));
const code2 = new URL(r.headers.get('location')).searchParams.get('code');
r = await call('POST', '/oauth/token', form({ grant_type: 'authorization_code', code: code2, client_id: conn.clientId, redirect_uri: DOCS + '/', code_verifier: verifier }));
assert.equal(r.status, 200);
const tok = await j(r);
assert.equal(tok.token_type, 'Bearer'); assert.ok(tok.access_token);
r = await call('POST', '/oauth/token', form({ grant_type: 'authorization_code', code: code2, client_id: conn.clientId, redirect_uri: DOCS, code_verifier: verifier }));
assert.equal(r.status, 400); ok('oauth: token issued once, code cannot be reused');

const V = tok.access_token;
assert.equal((await j(await call('GET', '/oauth/userinfo', { token: V }))).name, 'Shivad');
assert.equal((await j(await call('GET', '/api/db/nodes', { token: V }))).nodes.length, 2);
r = await call('GET', '/api/db/blobs/f_1', { token: V });
assert.equal((await r.arrayBuffer()).byteLength, 1000); ok('viewer token can list and read files');

// viewer token is read-only and cannot reach anything else
assert.equal((await call('PUT', '/api/db/nodes/f_1', { token: V, body: node })).status, 403);
assert.equal((await call('DELETE', '/api/db/nodes/f_1', { token: V })).status, 403);
assert.equal((await call('PUT', '/api/db/blobs/f_1', { token: V, raw: new Uint8Array(3), headers: { 'Content-Length': '3' } })).status, 403);
assert.equal((await call('GET', '/api/db/settings/theme', { token: V })).status, 403);
assert.equal((await call('GET', '/api/docs/link', { token: V })).status, 403);
assert.equal((await call('POST', '/api/db/clear', { token: V })).status, 403);
assert.equal((await call('DELETE', `/api/accounts/${acct.user.id}`, { token: V })).status, 403);
assert.equal((await j(await call('GET', '/api/db/nodes', { token: T }))).nodes.length, 2); ok('viewer token is read-only');

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

// delete file removes blob and share
assert.equal((await call('DELETE', '/api/db/nodes/f_1', { token: T })).status, 200);
assert.equal((await call('GET', `/s/${share.token}`)).status, 404);
assert.equal(files.m.has(`b/${acct.user.id}/f_1`), false); ok('deleting a file removes its data and share link');

// clear + delete account
await call('PUT', '/api/db/blobs/g_1', { token: T, raw: new Uint8Array(5), headers: { 'Content-Length': '5' } });
assert.ok(files.m.has(`b/${acct.user.id}/g_1`));
assert.equal((await call('DELETE', `/api/accounts/${acct.user.id}`, { token: T })).status, 200);
assert.equal(files.m.has(`b/${acct.user.id}/g_1`), false);
assert.equal((await call('GET', '/api/auth/me', { token: T })).status, 401); ok('deleting an account removes everything');

// unknown routes
assert.equal((await call('GET', '/api/nope')).status, 404);
assert.equal((await call('POST', '/oauth/token', form({ grant_type: 'password' }))).status, 400); ok('unknown routes and grants');

console.log(`\nall ${n} groups passed`);
