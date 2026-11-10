// A local stand-in for the Worker, for trying the drive in a browser without
// Cloudflare: node tests/dev-server.mjs [port]. Data is kept in memory only.
// MAIN_URL=http://localhost:8790 points it at a local Deluxe Main
// (Deluxe-Main: ALLOW_LOCALHOST=1 DRIVE_URL=http://localhost:8787 node tests/dev-server.mjs).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubCore } from '../worker/hub.js';
import { NodeSql } from './fakes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 8787);
const MAIN_URL = process.env.MAIN_URL || 'http://localhost:8790';
const hub = new HubCore(new NodeSql(), { MAIN_URL }, {
  verify: (token) => fetch(`${MAIN_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } }),
});
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

http.createServer(async (req, res) => {
  const origin = `http://${req.headers.host}`;
  const url = new URL(req.url, origin);
  const cors = { 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range, X-Deluxe-Mime, X-Deluxe-Name', 'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (/^\/(api|s)\//.test(url.pathname)) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, duplex: 'half' });
    const response = await hub.handle(request);
    const headers = Object.fromEntries(response.headers); Object.assign(headers, cors);
    res.writeHead(response.status, headers);
    return res.end(Buffer.from(await response.arrayBuffer()));
  }
  const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`dev server on http://localhost:${port}`));
