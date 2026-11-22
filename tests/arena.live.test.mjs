// Tests the online rooms (worker/arena.js) against Cloudflare's own local runtime, with real Deluxe accounts.
// Not part of the Node-only tests: it needs `npm i wrangler ws` somewhere and a dev server running:
//   npx wrangler dev --local --port 8787 --persist-to /tmp/arena-state --var ALLOW_LOCALHOST:1
//   node tests/arena.live.test.mjs          (from a folder where `ws` is installed)
// Use a fresh --persist-to folder each time: Deluxe Main limits how many accounts one address can create.
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const BASE = 'http://localhost:8787', WS = 'ws://localhost:8787', ORIGIN = 'http://localhost:5500';
let n = 0; const ok = (m) => console.log(`ok ${++n} ${m}`);
const api = async (method, path, { token, body, headers = {} } = {}) => {
  const h = { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) };
  const r = await fetch(BASE + '/main/api' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const salt = 'ab'.repeat(16), hash = 'cd'.repeat(32), tag = Math.random().toString(36).slice(2, 7);
async function player(name, app = 'kickoff') {
  let r = await api('POST', '/accounts', { body: { name: `${name} ${tag}`, salt, hash } });
  r = await api('POST', '/auth/login', { body: { name: `${name} ${tag}`, hash } });
  const main = r.data.token;
  if (app === 'main') return main;
  const back = ORIGIN + '/';
  r = await api('POST', '/connect/approve', { token: main, body: { return: back, app } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const code = /deluxe_code=([0-9a-f]+)/.exec(r.data.redirect)[1];
  r = await api('POST', '/connect/exchange', { body: { code, app }, headers: { Origin: ORIGIN } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.app, app);
  return r.data.token;
}
const open = (code, token, { create = false, origin = ORIGIN } = {}) => new Promise((resolve) => {
  const ws = new WebSocket(`${WS}/arena/${code}${create ? '?create=1' : ''}`, token ? ['deluxe.' + token] : [], { origin });
  const inbox = []; let waiter = null, closed = null;
  ws.on('message', (d) => { const m = JSON.parse(d); if (m.t === 'denied') { closed = { code: m.code, reason: m.reason }; ws.close(); } inbox.push(m); if (waiter) { const w = waiter; waiter = null; w(); } });
  ws.on('close', (c, r) => { closed = closed || { code: c, reason: r.toString() }; if (waiter) { const w = waiter; waiter = null; w(); } });
  ws.on('unexpected-response', (_q, res) => resolve({ rejected: res.statusCode }));
  ws.on('error', () => {});
  ws.on('open', () => resolve({
    ws, inbox, send: (m) => ws.send(JSON.stringify(m)), get closed() { return closed; },
    async next(pred, ms = 4000) { const t = Date.now(); for (;;) { const i = inbox.findIndex(pred); if (i >= 0) return inbox.splice(i, 1)[0]; if (closed) throw new Error('closed ' + JSON.stringify(closed)); if (Date.now() - t > ms) throw new Error('timeout waiting'); await new Promise((r) => { waiter = r; setTimeout(r, 200); }); } },
    async quiet(pred, ms = 700) { await new Promise((r) => setTimeout(r, ms)); return !inbox.some(pred); },
  }));
});
const room = () => Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');

const [ta, tb, tc, td] = [await player('Ann'), await player('Bob'), await player('Cy'), await player('Di')];
const mainToken = await player('Eve', 'main');

/* who gets in */
let r = await open(room(), null); assert.equal(r.rejected, 401); ok('no sign-in: refused');
r = await open(room(), mainToken); assert.equal(r.rejected, 401); ok('a Deluxe Main key (not a Nitro Kickoff one): refused');
r = await open(room(), ta, { origin: 'https://evil.example' }); assert.equal(r.rejected, 403); ok('another website: refused');
r = await open(room(), 'dm_not_a_key'); assert.equal(r.rejected, 401); ok('a made-up key: refused');

/* lobby */
const code = room();
const A = await open(code, ta, { create: true });
const helloA = await A.next((m) => m.t === 'hello'); assert.equal(helloA.host, true);
let lobby = await A.next((m) => m.t === 'lobby'); assert.equal(lobby.players.length, 1); assert.match(lobby.players[0].name, /^Ann /);
ok('create a room: you are the host, with your Deluxe name');
const missing = await open(room(), tb); const gone = await (async () => { for (let i = 0; i < 20 && !missing.closed; i++) await new Promise((r) => setTimeout(r, 100)); return missing.closed; })();
assert.equal(gone.code, 4404); ok('joining a room that does not exist: told so');
const dup = await open(code, tb, { create: true }); for (let i = 0; i < 20 && !dup.closed; i++) await new Promise((r) => setTimeout(r, 100)); assert.equal(dup.closed.code, 4409); ok('creating a taken code: refused');
const B = await open(code, tb);
assert.equal((await B.next((m) => m.t === 'hello')).host, false);
lobby = await A.next((m) => m.t === 'lobby' && m.players.length === 2);
assert.deepEqual(lobby.players.map((p) => p.team), [0, 1]); ok('second player joins; teams balance (blue, orange)');
B.send({ t: 'team', team: 0 }); lobby = await A.next((m) => m.t === 'lobby' && m.players.length === 2 && m.players[1].team === 0); ok('a player can change team');
B.send({ t: 'cfg', cfg: { map: 'frost', len: 120 } }); assert.ok(await A.quiet((m) => m.t === 'lobby' && m.cfg.map === 'frost')); ok('only the host can change settings');
A.send({ t: 'cfg', cfg: { map: 'frost', len: 300, diff: 'hacker' } }); lobby = await B.next((m) => m.t === 'lobby' && m.cfg.map === 'frost');
assert.equal(lobby.cfg.len, 300); assert.equal(lobby.cfg.diff, 'pro'); ok('host settings apply; invalid values ignored');

/* match */
B.send({ t: 'start' }); assert.ok(await A.quiet((m) => m.t === 'start')); ok('only the host can start');
A.send({ t: 'start' });
const sa = await A.next((m) => m.t === 'start'), sb = await B.next((m) => m.t === 'start'); assert.equal(sb.roster.length, 2); assert.equal(sa.cfg.map, 'frost'); ok('host starts: everyone gets the roster and settings');
const C = await open(code, tc); for (let i = 0; i < 20 && !C.closed; i++) await new Promise((r) => setTimeout(r, 100)); assert.equal(C.closed.code, 4423); ok('joining a match in progress: refused');
B.send({ t: 'in', th: 1, st: -1, j: 0, b: 1 });
const inp = await A.next((m) => m.t === 'in'); assert.equal(inp.th, 1); assert.equal(inp.id, sb.roster[1].id); ok("a player's controls reach the host, tagged with the real player id");
B.send({ t: 'in', id: 'someone-else', th: 0 }); const inp2 = await A.next((m) => m.t === 'in'); assert.equal(inp2.id, sb.roster[1].id); ok('a player cannot pose as another player');
A.send({ t: 'snap', n: 1, b: [0, 1, 2] }); assert.equal((await B.next((m) => m.t === 'snap')).n, 1); ok('host snapshots reach the other players');
B.send({ t: 'snap', n: 2 }); assert.ok(await A.quiet((m) => m.t === 'snap')); assert.ok(await B.quiet((m) => m.t === 'snap')); ok('a non-host cannot send snapshots');
const t0 = Date.now(); B.send({ t: 'ping', ts: t0 }); assert.equal((await B.next((m) => m.t === 'pong')).ts, t0); ok('ping/pong');

/* leaving */
A.ws.close();
const closed = await B.next((m) => m.t === 'closed'); assert.match(closed.reason, /host left/i);
lobby = await B.next((m) => m.t === 'lobby' && m.players.length === 1); assert.equal(lobby.players[0].host, true); assert.equal(lobby.started, false);
ok('host leaves: the match ends and the next player becomes host');
const D = await open(code, td); await D.next((m) => m.t === 'hello'); lobby = await B.next((m) => m.t === 'lobby' && m.players.length === 2); ok('the room is open to new players again');
B.ws.close(); D.ws.close(); await new Promise((r) => setTimeout(r, 400));
const again = await open(code, td); for (let i = 0; i < 20 && !again.closed; i++) await new Promise((r) => setTimeout(r, 100)); assert.equal(again.closed.code, 4404); ok('an empty room is gone');
console.log(`all ${n} passed`); process.exit(0);
