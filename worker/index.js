// The Deluxe server on Cloudflare Workers: one Worker for every Deluxe website.
//
//   /main/...        Deluxe Main: the account sign-in pages (main/) and, under
//                    /main/api/, the accounts, sign-ins and every website's
//                    saved data (the Main Durable Object, worker/main/core.js).
//   /api/..., /s/... Deluxe Drive's file contents and share links (the Hub
//                    Durable Object, worker/hub.js).
//   anything else    Deluxe Drive's own page (index.html, js/, ...).
//
// The two Durable Objects talk to each other directly: Drive asks Main whose a
// key is, and Main asks Drive to empty a deleted account's files.

import { DurableObject } from 'cloudflare:workers';
import { HubCore } from './hub.js';
import { MainCore } from './main/core.js';

const INTERNAL = 'https://deluxe.internal';

function mainStub(env) {
  return env.MAIN.get(env.MAIN.idFromName('deluxe-main'));
}

function hubStub(env) {
  return env.HUB.get(env.HUB.idFromName('main'));
}

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new HubCore(ctx.storage.sql, env, {
      verify: (token) =>
        mainStub(env).fetch(new Request(`${INTERNAL}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })),
    });
  }

  fetch(request) {
    return this.core.handle(request);
  }
}

export class Main extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new MainCore(ctx.storage.sql, env, {
      drive: (path, init = {}) => hubStub(env).fetch(new Request(`${INTERNAL}${path}`, init)),
    });
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
  headers.set(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Range, X-Deluxe-Mime, X-Deluxe-Name, X-Deluxe-App, X-Deluxe-Account'
  );
  headers.set('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Range, Accept-Ranges');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function missing(request, name) {
  return withCors(
    request,
    new Response(JSON.stringify({ error: `The ${name} Durable Object is not bound on this Worker.` }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (request.method === 'OPTIONS') return withCors(request, new Response(null, { status: 204 }));

    // Deluxe Main's API: /main/api/... reaches Main as /api/...
    if (pathname.startsWith('/main/api/')) {
      if (!env.MAIN) return missing(request, 'Main');
      const inner = new URL(url);
      inner.pathname = pathname.slice('/main'.length);
      return withCors(request, await mainStub(env).fetch(new Request(inner, request)));
    }

    // Deluxe Main's pages. /main/connect (and any other page address) shows
    // main/index.html; real files are served as they are.
    if (pathname === '/main' || pathname.startsWith('/main/')) {
      if (pathname === '/main') return Response.redirect(`${url.origin}/main/`, 301);
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
      const page = new URL(url);
      page.pathname = '/main/';
      return env.ASSETS.fetch(new Request(page, request));
    }

    if (/^\/(api|s)\//.test(pathname)) {
      if (!env.HUB) return missing(request, 'Hub');
      return withCors(request, await hubStub(env).fetch(request));
    }

    return env.ASSETS.fetch(request);
  },
};
