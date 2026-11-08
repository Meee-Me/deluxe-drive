// Deluxe Drive's server as a Vercel Function.
//
// vercel.json sends /api/* and /s/* here. The same server code as the
// Cloudflare Worker (worker/hub.js) answers: accounts, files, share links and
// link IDs for Deluxe Docs and Deluxe Convert. Everything is kept in Postgres:
// connect a database to the project (Storage, Neon) and Vercel sets
// DATABASE_URL. Without one, /api/health says so and the page keeps files in
// the browser as before.
import { HubCore } from '../worker/hub.js';
import { PgSql } from './_pg.mjs';

// A Vercel Function takes about 4.5 MB per request, so bigger files are sent
// in 4 MB pieces (the drive's page and Deluxe Convert do this by themselves).
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

let hub = null;
export function databaseUrl(env = process.env) {
  return env.DATABASE_URL || env.POSTGRES_URL || env.DATABASE_URL_UNPOOLED || env.POSTGRES_URL_NON_POOLING || '';
}

function getHub() {
  const url = databaseUrl();
  if (!url) return null;
  if (!hub) {
    hub = new HubCore(new PgSql(url), {
      MAX_REQUEST_BYTES,
      MAX_UPLOAD_BYTES: process.env.MAX_UPLOAD_BYTES,
      DELUXE_FAKE_SECRET: process.env.DELUXE_FAKE_SECRET,
    });
  }
  return hub;
}

// Any site may call the API: every request carries its own bearer token and
// no cookies are used, so there is nothing for another site to ride on.
function withCors(request, response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', request.headers.get('origin') || '*');
  headers.set('Vary', 'Origin');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range, X-Deluxe-Mime, X-Deluxe-Name');
  headers.set('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Range, Accept-Ranges');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// vercel.json passes the path the browser asked for as ?__p, so the hub
// sees /api/... or /s/... whatever the function itself is called.
export function originalRequest(request) {
  const url = new URL(request.url);
  const asked = url.searchParams.get('__p');
  if (!asked) return request;
  url.searchParams.delete('__p');
  url.pathname = asked.startsWith('/') ? asked : `/${asked}`;
  const init = { method: request.method, headers: request.headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

function noDatabase() {
  return new Response(
    JSON.stringify({
      ok: false,
      server: false,
      error:
        'Deluxe Drive has no database yet. In Vercel, open the deluxe-drive project, Storage, create a Neon (Postgres) database and connect it, then redeploy.',
      code: 'no-database',
    }),
    { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
}

export async function handle(request) {
  if (request.method === 'OPTIONS') return withCors(request, new Response(null, { status: 204 }));
  const core = getHub();
  if (!core) return withCors(request, noDatabase());
  try {
    return withCors(request, await core.handle(originalRequest(request)));
  } catch (error) {
    console.error('Deluxe Drive server error:', error);
    return withCors(
      request,
      new Response(JSON.stringify({ error: 'The drive could not answer that. Try again in a moment.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    );
  }
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
