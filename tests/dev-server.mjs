// The whole Deluxe Worker on your computer: Deluxe Main at /main, Deluxe Drive
// at /. Data is kept in memory only. Run:
//   node --import ./tests/register.mjs tests/dev-server.mjs [port]
// and open http://localhost:8787 (Drive) or http://localhost:8787/main/ (Main).
import http from 'node:http';
import { makeWorker } from './local-worker.mjs';

const port = Number(process.argv[2] || 8787);
const worker = await makeWorker({ ALLOW_LOCALHOST: '1', APP_KEY_MAIL: process.env.APP_KEY_MAIL || '' });

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await worker.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`Deluxe server on http://localhost:${port} (Main at /main/)`));
