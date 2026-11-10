// Deluxe Drive on Cloudflare Workers: the file contents of every Deluxe
// account. Accounts and everything else live in Deluxe Main.
//
// Static files (index.html, js/, styles.css, ...) are served by Workers
// Assets. Everything under /api and /s goes to one Durable
// Object, which keeps the accounts and files in its SQLite database (or the
// files in R2, when a bucket is bound as FILES).

import { DurableObject } from 'cloudflare:workers';
import { HubCore } from './hub.js';

const DEFAULT_MAIN_URL = 'https://deluxe-main.deluxelordd.workers.dev';

// Every key is checked with Deluxe Main, through the MAIN service binding when
// there is one, otherwise over its address.
function mainVerifier(env) {
  const base = String(env.MAIN_URL || DEFAULT_MAIN_URL).replace(/\/+$/, '');
  return (token) => {
    const request = new Request(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    return env.MAIN ? env.MAIN.fetch(request) : fetch(request);
  };
}

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new HubCore(ctx.storage.sql, env, { verify: mainVerifier(env) });
  }

  fetch(request) {
    return this.core.handle(request);
  }
}

// Any site may call the API: every request carries its own bearer token, and
// no cookies are used, so there is nothing for another site to ride on.
function withCors(request, response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', request.headers.get('Origin') || '*');
  headers.set('Vary', 'Origin');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range, X-Deluxe-Mime, X-Deluxe-Name');
  headers.set('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Range, Accept-Ranges');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return withCors(request, new Response(null, { status: 204 }));

    const { pathname } = new URL(request.url);
    if (/^\/(api|s)\//.test(pathname)) {
      if (!env.HUB) {
        return withCors(
          request,
          new Response(JSON.stringify({ error: 'The Hub Durable Object is not bound on this Worker.' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }
      const hub = env.HUB.get(env.HUB.idFromName('main'));
      return withCors(request, await hub.fetch(request));
    }

    return env.ASSETS.fetch(request);
  },
};
