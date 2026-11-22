// Online rooms for Deluxe Games (Nitro Kickoff). One Durable Object per room code.
//
// It only passes messages between the players of a room: the host's browser runs the
// match and sends snapshots, the others send their controls. Who a player is comes
// from the Worker (a verified Deluxe Main sign-in); nothing here trusts the browser
// about names. Sockets use WebSocket hibernation, so an idle room costs nothing.

import { DurableObject } from 'cloudflare:workers';

const MAX_PER_TEAM = 3;
const MAX_MESSAGE = 8000;
const MAPS = new Set(['grass', 'neon', 'spud', 'frost']);
const LENGTHS = new Set([120, 180, 300]);
const DIFFS = new Set(['rookie', 'pro', 'ace']);

const MAX_PER_SECOND = 150;  // the host sends ~60 a second at most (controls from each guest ~60, snapshots 30)
const budget = new WeakMap();
const send = (ws, msg) => { try { ws.send(JSON.stringify(msg)); } catch (e) { /* socket already closing */ } };

export class Arena extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = { started: false, seq: 0, cfg: { map: 'grass', len: 180, diff: 'pro' } };
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('room');
      if (saved) this.room = saved;
    });
  }

  people(except) {
    return this.ctx.getWebSockets().filter((ws) => ws !== except).map((ws) => ({ ws, a: ws.deserializeAttachment() })).filter((p) => p.a)
      .sort((x, y) => x.a.n - y.a.n);
  }

  save() { return this.ctx.storage.put('room', this.room); }

  lobby(except) {
    const list = this.people(except);
    const msg = { t: 'lobby', started: this.room.started, cfg: this.room.cfg, players: list.map((p) => ({ id: p.a.id, name: p.a.name, team: p.a.team, host: p.a.host })) };
    for (const p of list) send(p.ws, msg);
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const id = request.headers.get('X-Arena-Id') || '';
    const name = (request.headers.get('X-Arena-Name') || 'Player').slice(0, 24);
    const create = request.headers.get('X-Arena-Create') === '1';
    const protocol = request.headers.get('Sec-WebSocket-Protocol');
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    const headers = protocol ? { 'Sec-WebSocket-Protocol': protocol.split(',')[0].trim() } : {};
    const list = this.people();
    // a close frame sent before the handshake finishes is lost, so tell the player in a message; their browser then closes the socket
    const refuse = (code, reason) => { server.send(JSON.stringify({ t: 'denied', code, reason })); return new Response(null, { status: 101, webSocket: client, headers }); };
    if (create && list.length) return refuse(4409, 'That room code is taken. Try again.');
    if (!create && !list.length) return refuse(4404, 'No room with that code.');
    if (this.room.started) return refuse(4423, 'That match has already started.');
    if (list.length >= MAX_PER_TEAM * 2) return refuse(4423, 'That room is full.');
    const blue = list.filter((p) => p.a.team === 0).length, orange = list.length - blue;
    const a = { id: id + '.' + (this.room.seq + 1), name, team: blue <= orange ? 0 : 1, host: !list.length, n: ++this.room.seq };
    server.serializeAttachment(a);
    await this.save();
    send(server, { t: 'hello', id: a.id, host: a.host });
    this.lobby();
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE) return;
    const now = Date.now(), b = budget.get(ws) || { at: now, n: 0 };
    if (now - b.at >= 1000) { b.at = now; b.n = 0; }
    budget.set(ws, b);
    if (++b.n > MAX_PER_SECOND) return;  // a player flooding messages is ignored, not passed on
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    const a = ws.deserializeAttachment();
    if (!a || !m || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'ping': return send(ws, { t: 'pong', ts: m.ts });
      case 'team': {
        if (this.room.started || (m.team !== 0 && m.team !== 1)) return;
        if (this.people().filter((p) => p.a.team === m.team && p.ws !== ws).length >= MAX_PER_TEAM) return;
        a.team = m.team; ws.serializeAttachment(a); return this.lobby();
      }
      case 'cfg': {
        if (!a.host || this.room.started || !m.cfg) return;
        const c = this.room.cfg;
        if (MAPS.has(m.cfg.map)) c.map = m.cfg.map;
        if (LENGTHS.has(m.cfg.len)) c.len = m.cfg.len;
        if (DIFFS.has(m.cfg.diff)) c.diff = m.cfg.diff;
        await this.save(); return this.lobby();
      }
      case 'start': {
        if (!a.host || this.room.started) return;
        this.room.started = true; await this.save();
        const roster = this.people().map((p) => ({ id: p.a.id, name: p.a.name, team: p.a.team, host: p.a.host }));
        for (const p of this.people()) send(p.ws, { t: 'start', cfg: this.room.cfg, roster });
        return;
      }
      case 'end': {
        if (!a.host || !this.room.started) return;
        this.room.started = false; await this.save(); return this.lobby();
      }
      case 'in': {  // a player's controls go to the host only
        if (a.host || !this.room.started) return;
        const host = this.people().find((p) => p.a.host);
        if (host) { m.id = a.id; send(host.ws, m); }
        return;
      }
      case 'snap': case 'fx': {  // the host's match state goes to everyone else
        if (!a.host) return;
        for (const p of this.people(ws)) p.ws.send(data);
        return;
      }
      default:
    }
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch (e) { /* already closed */ }
    const rest = this.people(ws);
    if (!rest.length) { this.room = { started: false, seq: 0, cfg: { map: 'grass', len: 180, diff: 'pro' } }; await this.ctx.storage.deleteAll(); return; }
    const was = ws.deserializeAttachment();
    if (was && was.host) {  // the oldest remaining player takes over; a match in progress ends
      const next = rest[0];
      next.a.host = true; next.ws.serializeAttachment(next.a);
      if (this.room.started) { this.room.started = false; await this.save(); for (const p of rest) send(p.ws, { t: 'closed', reason: 'The host left, so the match ended.' }); }
    }
    if (this.room.started && was) for (const p of rest) send(p.ws, { t: 'left', id: was.id });
    this.lobby(ws);
  }

  async webSocketError(ws) { return this.webSocketClose(ws); }
}
