// The whole Worker: Deluxe Main at /main and Deluxe Drive at /api, together.
// Run: node --import ./tests/register.mjs tests/combined.test.mjs
import assert from 'node:assert/strict';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { makeWorker } from './local-worker.mjs';

const W = await makeWorker({ ALLOW_LOCALHOST: '0' });
const O = 'https://deluxe-drive.deluxelordd.workers.dev';
const derive = (pw, s) => pbkdf2Sync(pw, Buffer.from(s, 'hex'), 120000, 32, 'sha256').toString('hex');
async function call(method, p, { token, body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload = raw;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  return W.fetch(new Request(O + p, { method, headers: h, body: payload }));
}
let n = 0;
const ok = (m) => console.log(`ok ${++n} ${m}`);

let r = await call('GET', '/main/');
assert.equal(r.status, 200); assert.match(await r.text(), /Deluxe Main/);
r = await call('GET', '/main/connect?return=x');
assert.match(await r.text(), /Deluxe Main/);
r = await call('GET', '/main/deluxe.js');
assert.match(await r.text(), /Sign in with Deluxe Main/);
r = await call('GET', '/main/api/health');
assert.equal((await r.json()).name, 'Deluxe Main');
assert.equal(r.headers.get('access-control-allow-origin'), '*');
r = await call('GET', '/api/health');
assert.equal((await r.json()).main, `${O}/main`);
ok('one Worker serves Main pages, Main API and Drive');

const salt = randomBytes(16).toString('hex'), hash = derive('password123', salt);
r = await call('POST', '/main/api/accounts', { body: { name: 'One Server', salt, hash } });
const mainToken = (await r.json()).token;
r = await call('POST', '/main/api/connect/approve', { token: mainToken, body: { return: `${O}/` } });
const code = /deluxe_code=(\w+)/.exec((await r.json()).redirect)[1];
r = await call('POST', '/main/api/connect/exchange', { body: { code }, headers: { Origin: O } });
const driveToken = (await r.json()).token;
r = await call('PUT', '/api/db/blobs/f1', { token: driveToken, raw: new TextEncoder().encode('hi'), headers: { 'Content-Length': '2' } });
assert.equal(r.status, 201, 'Drive accepts a Main key through the Main Durable Object');
r = await call('PUT', '/main/api/data/drive/node:f1', { token: driveToken, body: { value: { id: 'f1', name: 'hi.txt' } } });
assert.equal(r.status, 200);
ok('Drive checks keys with Main inside the same Worker');

r = await call('POST', '/main/api/account/delete', { token: mainToken, body: { hash } });
assert.equal(r.status, 200, 'Main empties the Drive files through the Hub Durable Object');
r = await call('GET', '/api/db/blobs/f1', { token: driveToken });
assert.notEqual(r.status, 200, 'the file is gone');
ok('deleting the account empties its files');
console.log(`all ${n} passed`);
