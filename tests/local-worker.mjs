// The whole Deluxe Worker (worker/index.js) running in Node, with node:sqlite
// for the Durable Objects and the repository's files as Workers Assets.
// Load with: node --import ./tests/register.mjs ...
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeSql } from './fakes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

function assets() {
  return {
    async fetch(request) {
      let { pathname } = new URL(request.url);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const file = path.join(root, decodeURIComponent(pathname));
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return new Response('Not found', { status: 404 });
      return new Response(fs.readFileSync(file), { headers: { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' } });
    },
  };
}

export async function makeWorker(vars = {}) {
  const mod = await import('../worker/index.js');
  const env = { ...vars, ASSETS: assets() };
  const namespace = (Cls) => {
    let one = null;
    return {
      idFromName: (name) => name,
      get: () => {
        if (!one) one = new Cls({ storage: { sql: new NodeSql() } }, env);
        return { fetch: (req) => one.fetch(req) };
      },
    };
  };
  env.HUB = namespace(mod.Hub);
  env.MAIN = namespace(mod.Main);
  return { fetch: (request) => mod.default.fetch(request, env), env };
}
