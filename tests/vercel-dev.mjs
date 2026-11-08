// A local stand-in for the drive on Vercel: static files, plus /api/* and /s/*
// sent to the Vercel Function (api/hub.mjs) the way vercel.json rewrites them.
//   FAKE_BLOB=1 node tests/vercel-dev.mjs [port]   Vercel Blob storage, faked in memory
//   DATABASE_URL=postgres://... node tests/vercel-dev.mjs [port]   Postgres
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as fn from '../api/hub.mjs';
import { HubCore } from '../worker/hub.js';
import { BlobBackend } from '../api/_blob.mjs';
import { FakeBlobSdk } from './fakes.mjs';

if (process.env.FAKE_BLOB === '1') {
  fn.setBackend(new BlobBackend(new FakeBlobSdk(), (sql, files) => new HubCore(sql, fn.hubEnv({ FILE_STORE: files }))));
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 8788);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const api = url.pathname.startsWith('/api/') || url.pathname.startsWith('/s/');
  if (api) {
    // vercel.json: /api/:path* -> /api/hub?__p=/api/:path*, /s/:token -> /api/hub?__p=/s/:token
    const target = new URL('/api/hub', url);
    url.searchParams.forEach((v, k) => target.searchParams.append(k, v));
    target.searchParams.set('__p', url.pathname);
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const request = new Request(target, { method: req.method, headers: req.headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half' });
    const response = await fn[req.method](request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
    return;
  }
  const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`vercel stand-in on http://localhost:${port}`));
