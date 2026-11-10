// The Deluxe server on Cloudflare Workers: one Worker for every Deluxe website.
//
//   /main/api/...    Deluxe Main's data: accounts, sign-ins and every website's
//                    saved data (the Main Durable Object, worker/main/core.js).
//                    Deluxe Main's website is on Vercel (MAIN_SITE), which passes
//                    its /api requests on to here.
//   /main/...        anything else under /main goes to that Vercel site.
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
const DEFAULT_MAIN_SITE = 'https://deluxe-main.vercel.app';

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

    // Deluxe Main's website is only on Vercel.
    if (pathname === '/main' || pathname.startsWith('/main/')) {
      const site = String(env.MAIN_SITE || DEFAULT_MAIN_SITE).replace(/\/+$/, '');
      return Response.redirect(`${site}${pathname.slice('/main'.length) || '/'}${url.search}`, 302);
    }

    if (/^\/(api|s)\//.test(pathname)) {
      if (!env.HUB) return missing(request, 'Hub');
      return withCors(request, await hubStub(env).fetch(request));
    }

    return env.ASSETS.fetch(request);
  },
};
