'use strict';

// The Deluxe Drive server.
//
// It does three things:
//   - serves the drive (index.html, js/, styles.css, vendor/) as it always was,
//   - stores each account's files on disk behind a token, so the drive can be
//     opened from more than one device and its files can be shared,
//   - lets a viewer such as Deluxe Docs sign in with OAuth 2.0 + PKCE and read
//     the files it is given.
//
// Zero dependencies: node's own http, fs and crypto modules only.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const store = require('./store');
const oauth = require('./oauth');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const SERVER_NAME = 'Deluxe Drive';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
// A single file may be up to this many bytes. A Cloud Run instance keeps its
// writable disk in memory, so the default stays modest and can be raised with
// MAX_UPLOAD_BYTES when the server runs somewhere with real storage.
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 256 * 1024 * 1024);
const MAX_FORM_BYTES = 64 * 1024;

const SETTINGS_KEY = /^[A-Za-z0-9_.-]{1,60}$/;

/* ------------------------------------------------------------------ */
/* Static files                                                        */
/* ------------------------------------------------------------------ */

// Only the drive itself is served. server/ and the data directory are not
// reachable from the web, whatever the request asks for.
const STATIC_ALLOWED = new Set([
  'index.html',
  'check.html',
  'styles.css',
  'icon.svg',
  'icon-maskable.svg',
  'manifest.webmanifest',
  'README.md',
]);
const STATIC_ALLOWED_DIRS = new Set(['js', 'vendor']);

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/* ------------------------------------------------------------------ */
/* Small HTTP helpers                                                  */
/* ------------------------------------------------------------------ */

function applyCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range, X-Deluxe-Mime, X-Deluxe-Name');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Disposition, Content-Length, Content-Range, Accept-Ranges'
  );
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  const body = String(html || '');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text) {
  const body = String(text || '');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function notFound(res) {
  sendText(res, 404, 'Not found');
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return value;
  }
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : '';
}

function sessionOf(req) {
  const token = bearerToken(req);
  return token ? store.sessionFor(token) : null;
}

function requireSession(ctx) {
  const session = sessionOf(ctx.req);
  if (!session) {
    sendJson(ctx.res, 401, { error: 'Sign in to Deluxe Drive again.', code: 'unauthorized' });
    return null;
  }
  return session;
}

function publicOrigin(req) {
  const proto =
    String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim() || (req.socket && req.socket.encrypted ? 'https' : 'http');
  const host =
    String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost')
      .split(',')[0]
      .trim() || 'localhost';
  return `${proto}://${host}`;
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('That request is too large.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const raw = await readBody(req, MAX_JSON_BYTES);
  if (!raw.length) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    const failure = new Error('That request could not be read.');
    failure.status = 400;
    throw failure;
  }
}

async function readFormBody(req) {
  const raw = await readBody(req, MAX_FORM_BYTES);
  return new URLSearchParams(raw.toString('utf8'));
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

const routes = [];

function route(method, pattern, handler) {
  routes.push({ method, segments: pattern.split('/').filter(Boolean), handler });
}

function matchRoute(method, segments) {
  for (const entry of routes) {
    if (entry.method !== method) continue;
    if (entry.segments.length !== segments.length) continue;

    const params = {};
    let matched = true;

    for (let index = 0; index < segments.length; index += 1) {
      const expected = entry.segments[index];
      if (expected.startsWith(':')) {
        params[expected.slice(1)] = segments[index];
        continue;
      }
      if (expected !== segments[index]) {
        matched = false;
        break;
      }
    }

    if (matched) return { handler: entry.handler, params };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Accounts and sessions                                               */
/* ------------------------------------------------------------------ */

route('GET', '/api/health', (ctx) => {
  sendJson(ctx.res, 200, {
    ok: true,
    name: SERVER_NAME,
    server: true,
    storage: 'server',
    version: 'server 1',
    oauth: {
      authorize: '/oauth/authorize',
      token: '/oauth/token',
      userInfo: '/oauth/userinfo',
    },
    limits: {
      uploadBytes: MAX_UPLOAD_BYTES,
    },
  });
});

route('POST', '/api/auth/session', async (ctx) => {
  const body = await readJsonBody(ctx.req);
  const account = await store.accountById(String(body.userId || ''));
  const hash = String(body.hash || '');

  if (!account || !store.safeEqual(account.hash, hash)) {
    sendJson(ctx.res, 401, { error: 'That account did not match.', code: 'unauthorized' });
    return;
  }

  const session = store.createSession(account.id, { scope: 'drive', ttlSeconds: store.SESSION_TTL_SECONDS });
  sendJson(ctx.res, 200, {
    token: session.token,
    expiresIn: session.expiresIn,
    user: { id: account.id, name: account.name },
  });
});

route('GET', '/api/auth/me', async (ctx) => {
  const session = requireSession(ctx);
  if (!session) return;

  const account = await store.accountById(session.userId);
  if (!account) {
    sendJson(ctx.res, 401, { error: 'Sign in to Deluxe Drive again.', code: 'unauthorized' });
    return;
  }

  sendJson(ctx.res, 200, { user: { id: account.id, name: account.name } });
});

route('POST', '/api/accounts', async (ctx) => {
  const body = await readJsonBody(ctx.req);

  let account;
  try {
    account = await store.createAccount({ name: body.name, salt: body.salt, hash: body.hash });
  } catch (error) {
    const status = error.status || 500;
    sendJson(ctx.res, status, {
      error: error.status ? error.message : 'That account could not be made.',
      code: error.code || (status === 409 ? 'name-taken' : 'create-failed'),
    });
    return;
  }

  const session = store.createSession(account.id, { scope: 'drive', ttlSeconds: store.SESSION_TTL_SECONDS });
  sendJson(ctx.res, 201, {
    token: session.token,
    expiresIn: session.expiresIn,
    user: { id: account.id, name: account.name },
  });
});

// Never says whether a name is taken: an unknown name gets a made-up record
// and the sign-in that follows simply cannot succeed.
route('POST', '/api/accounts/find', async (ctx) => {
  const body = await readJsonBody(ctx.req);
  const name = String(body.name || '').trim();
  if (!name) {
    sendJson(ctx.res, 400, { error: 'Type your account name.' });
    return;
  }

  const account = await store.accountByName(name);
  sendJson(ctx.res, 200, account ? store.publicAccount(account) : store.fakeAccount(name));
});

route('GET', '/api/accounts/:id', async (ctx) => {
  const account = await store.accountById(ctx.params.id);
  if (!account) {
    sendJson(ctx.res, 404, { error: 'That account is not here.' });
    return;
  }
  sendJson(ctx.res, 200, store.publicAccount(account));
});

route('PATCH', '/api/accounts/:id', async (ctx) => {
  const session = requireSession(ctx);
  if (!session) return;
  if (session.userId !== ctx.params.id) {
    sendJson(ctx.res, 403, { error: 'That is not your account.' });
    return;
  }

  const body = await readJsonBody(ctx.req);
  try {
    const account = await store.renameAccount(session.userId, body.name);
    sendJson(ctx.res, 200, { user: { id: account.id, name: account.name } });
  } catch (error) {
    sendJson(ctx.res, error.status || 500, { error: error.message || 'That name could not be saved.' });
  }
});

route('POST', '/api/accounts/:id/password', async (ctx) => {
  const session = requireSession(ctx);
  if (!session) return;
  if (session.userId !== ctx.params.id) {
    sendJson(ctx.res, 403, { error: 'That is not your account.' });
    return;
  }

  const body = await readJsonBody(ctx.req);
  const account = await store.accountById(session.userId);
  if (!account || !store.safeEqual(account.hash, String(body.currentHash || ''))) {
    sendJson(ctx.res, 401, { error: 'That password is not correct.', code: 'unauthorized' });
    return;
  }

  try {
    await store.setAccountPassword(session.userId, body.salt, body.hash);
    sendJson(ctx.res, 200, { ok: true });
  } catch (error) {
    sendJson(ctx.res, error.status || 500, { error: error.message || 'That password could not be saved.' });
  }
});

route('DELETE', '/api/accounts/:id', async (ctx) => {
  const session = requireSession(ctx);
  if (!session) return;
  if (session.userId !== ctx.params.id) {
    sendJson(ctx.res, 403, { error: 'That is not your account.' });
    return;
  }

  const removed = await store.deleteAccount(session.userId);
  if (!removed) {
    sendJson(ctx.res, 404, { error: 'That account is not here.' });
    return;
  }

  store.dropSession(bearerToken(ctx.req));
  sendJson(ctx.res, 200, { ok: true });
});

/* ------------------------------------------------------------------ */
/* The drive's own storage: nodes, files and settings                  */
/* ------------------------------------------------------------------ */

route('GET', '/api/db/nodes', async (ctx) => {
  const session = requireSession(ctx);
  if (!session) return;
  const nodes = await store.listNodes(session.userId);
  sendJson(ctx.res, 200, { nodes });
});

route('GET', '/api/db/nodes/:id', async (ctx) => {
  const session = requireSession(ctx);
  if (!session) return;

  const node = await store.getNode(session.userId, ctx.params.id);
  if (!node) {
    sendJson(ctx.res, 404, { error: 'That file is not here.' });
    return;
  }

  sendJson(ctx.res, 200, { node });
});

route('POST', '/api/db/nodes', async (ctx) => {
  const session = requireSession(ctx);
  if (!session) return;

  const body = await readJsonBody(ctx.req);
  try {
    const count = await store.putNodes(session.userId, body.nodes);
    sendJson(ctx.res, 200, { ok: true, count });
  } catch (error) {
    sendJson(ctx.res, error.status || 400, { error: error.message || 'Those files could not be saved.' });
  }
});

route('PUT', '/api/db/nodes/:id', async (ctx) => {
  const session = requireSession(ctx);
  if (!session) return;

  const body = await readJsonBody(ctx.req);
  const node = { ...body, id: ctx.params.id };

  try {
    await store.putNode(session.userId, node);
    sendJson(ctx.res, 200, { ok: true, id: node.id });
  } catch (error) {
    sendJson(ctx.res, error.status || 400, { error: error.message || 'That file could not be saved.' });
  }
});

route('DELETE', '/api/db/nodes/:id', async (ctx) => {
  const session = requireSession(ctx);
  if (!session) return;

  // Blobs and share links are keyed by the node id, so deleting the file also
  // puts an end to its stored data and to any link that still pointed at it.
  await store.deleteNode(session.userId, ctx.params.id);
  await store.deleteBlob(session.userId, ctx.params.id);
  await store.revokeShare(session.userId, ctx.params.id);
  sendJson(ctx.res, 200, { ok: true });
});

route('GET', '/api/db/blobs/:id', async (ctx) => {
  const session = requireSession(ctx);
  if (!session) return;

  const info = await store.blobInfo(session.userId, ctx.params.id);
  if (!info) {
    sendJson(ctx.res, 404, { error: 'That file has no stored data.' });
    return;
  }

  const node = await store.getNode(session.userId, ctx.params.id);
  streamBlob(ctx.req, ctx.res, info, node ? node.name : ctx.params.id, false);
});

route('PUT', '/api/db/blobs/:id', async (ctx) => {
  const session = requireSession(ctx);
  if (!session) return;

  const declared = Number(ctx.req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD_BYTES) {
    sendJson(ctx.res, 413, { error: 'That file is too large for this server.' });
    return;
  }

  const mime = String(
    ctx.req.headers['x-deluxe-mime'] || ctx.req.headers['content-type'] || 'application/octet-stream'
  );

  try {
    const size = await store.saveBlob(session.userId, ctx.params.id, ctx.req, mime);
    sendJson(ctx.res, 201, { ok: true, id: ctx.params.id, size, mime });
  } catch (error) {
    if (!ctx.res.headersSent) {
      sendJson(ctx.res, 400, { error: 'That file could not be stored.' });
    }
  }
});

route('DELETE', '/api/db/blobs/:id', async (ctx) => {
  const session = requireSession(ctx);
  if (!session) return;
  await store.deleteBlob(session.userId, ctx.params.id);
  sendJson(ctx.res, 200, { ok: true });
});

route('GET', '/api/db/settings/:key', async (ctx) => {
  const session = requireSession(ctx);
  if (!session) return;
  if (!SETTINGS_KEY.test(ctx.params.key)) {
    sendJson(ctx.res, 400, { error: 'That setting name is not valid.' });
    return;
  }

  const value = await store.getSetting(session.userId, ctx.params.key);
  if (value === undefined) {
    sendJson(ctx.res, 404, { error: 'That setting is not set.' });
    return;
  }
  sendJson(ctx.res, 200, { key: ctx.params.key, value });
});

route('PUT', '/api/db/settings/:key', async (ctx) => {
  const session = requireSession(ctx);
  if (!session) return;
  if (!SETTINGS_KEY.test(ctx.params.key)) {
    sendJson(ctx.res, 400, { error: 'That setting key is not valid.' });
    return;
  }

  const body = await readJsonBody(ctx.req);
  await store.putSetting(session.userId, ctx.params.key, body.value);
  sendJson(ctx.res, 200, { ok: true, key: ctx.params.key });
});

route('DELETE', '/api/db/settings/:key', async (ctx) => {
  const session = requireSession(ctx);
  if (!session) return;
  await store.deleteSetting(session.userId, ctx.params.key);
  sendJson(ctx.res, 200, { ok: true });
});

route('POST', '/api/db/clear', async (ctx) => {
  const session = requireSession(ctx);
  if (!session) return;
  await store.clearAccountData(session.userId);
  sendJson(ctx.res, 200, { ok: true });
});

/* ------------------------------------------------------------------ */
/* Share links                                                         */
/* ------------------------------------------------------------------ */

route('POST', '/api/files/:id/share', async (ctx) => {
  const session = requireSession(ctx);
  if (!session) return;

  const node = await store.getNode(session.userId, ctx.params.id);
  if (!node) {
    sendJson(ctx.res, 404, { error: 'That file is not here.' });
    return;
  }
  if (node.type !== 'file') {
    sendJson(ctx.res, 400, { error: 'Folders cannot be shared on their own.' });
    return;
  }

  const { token } = await store.ensureShare(session.userId, node.id, node.name);
  sendJson(ctx.res, 200, {
    token,
    path: `/s/${token}`,
    url: `${publicOrigin(ctx.req)}/s/${token}`,
    name: node.name,
  });
});

route('DELETE', '/api/files/:id/share', async (ctx) => {
  const session = requireSession(ctx);
  if (!session) return;
  await store.revokeShare(session.userId, ctx.params.id);
  sendJson(ctx.res, 200, { ok: true });
});

route('GET', '/api/files/shares', async (ctx) => {
  const session = requireSession(ctx);
  if (!session) return;

  const shares = await store.listShares(session.userId);
  const origin = publicOrigin(ctx.req);

  sendJson(ctx.res, 200, {
    shares: shares.map((share) => ({
      token: share.token,
      name: share.name,
      fileId: share.blobId,
      createdAt: share.createdAt,
      path: `/s/${share.token}`,
      url: `${origin}/s/${share.token}`,
    })),
  });
});

route('GET', '/api/shared/:token', async (ctx) => {
  await serveShared(ctx.req, ctx.res, ctx.params.token);
});

/* ------------------------------------------------------------------ */
/* OAuth clients: the viewers allowed to open files                    */
/* ------------------------------------------------------------------ */

route('GET', '/api/oauth/clients', async (ctx) => {
  const session = requireSession(ctx);
  if (!session) return;
  const clients = await store.listClients();
  sendJson(ctx.res, 200, {
    clients: clients.map((client) => ({
      clientId: client.id,
      name: client.name,
      redirectUri: client.redirectUri,
      createdAt: client.createdAt,
    })),
  });
});

route('POST', '/api/oauth/clients', async (ctx) => {
  const session = requireSession(ctx);
  if (!session) return;

  const body = await readJsonBody(ctx.req);
  const redirectUri = oauth.normalizeRedirect(body.redirectUri);
  if (!redirectUri) {
    sendJson(ctx.res, 400, { error: 'That page address is not a valid https address.' });
    return;
  }

  const client = await store.registerClient({ name: body.name, redirectUri });
  const code = store.issueDocsLink(client.id, session.userId);

  sendJson(ctx.res, 201, {
    clientId: client.id,
    name: client.name,
    redirectUri: client.redirectUri,
    code,
    link: `${publicOrigin(ctx.req)}/connect/${code}`,
  });
});

route('DELETE', '/api/oauth/clients/:id', async (ctx) => {
  const session = requireSession(ctx);
  if (!session) return;
  await store.removeClient(ctx.params.id);
  sendJson(ctx.res, 200, { ok: true });
});

/* ------------------------------------------------------------------ */
/* File streaming                                                      */
/* ------------------------------------------------------------------ */

function asciiFilename(name) {
  return String(name || 'file')
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_')
    .slice(0, 180);
}

// "bytes=0-499", "bytes=500-" and "bytes=-500" are the three forms a browser
// sends; anything else is ignored and the whole file is served.
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match) return null;

  const hasStart = match[1] !== '';
  const hasEnd = match[2] !== '';
  if (!hasStart && !hasEnd) return null;

  let start;
  let end;

  if (!hasStart) {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = hasEnd ? Number(match[2]) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start > end || start >= size) return { invalid: true };
  if (end >= size) end = size - 1;

  return { start, end };
}

function streamBlob(req, res, info, name, attachment) {
  const filename = String(name || 'file');
  const disposition = `${attachment ? 'attachment' : 'inline'}; filename="${asciiFilename(
    filename
  )}"; filename*=UTF-8''${encodeURIComponent(filename)}`;

  const size = Number(info.size) || 0;
  const base = {
    'Content-Type': info.mime || 'application/octet-stream',
    'Content-Disposition': disposition,
    'Cache-Control': 'private, max-age=0, must-revalidate',
    'Accept-Ranges': 'bytes',
  };

  const range = req.headers.range ? parseRange(req.headers.range, size) : null;

  if (range && range.invalid) {
    res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
    res.end();
    return;
  }

  let status = 200;
  let start = 0;
  let end = size > 0 ? size - 1 : 0;
  const headers = { ...base, 'Content-Length': size };

  if (range) {
    status = 206;
    start = range.start;
    end = range.end;
    headers['Content-Length'] = end - start + 1;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }

  res.writeHead(status, headers);

  if (req.method === 'HEAD' || size === 0) {
    res.end();
    return;
  }

  const stream = range
    ? fs.createReadStream(info.path, { start, end })
    : fs.createReadStream(info.path);
  stream.on('error', () => {
    res.destroy();
  });
  stream.pipe(res);
}

async function serveShared(req, res, token) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'Only reading is allowed here.' });
    return;
  }

  const share = await store.shareByToken(token);
  if (!share) {
    notFound(res);
    return;
  }

  const info = await store.blobInfo(share.accountId, share.blobId);
  if (!info) {
    notFound(res);
    return;
  }

  streamBlob(req, res, info, share.name || share.blobId, false);
}

/* ------------------------------------------------------------------ */
/* A connection link for Deluxe Docs                                   */
/* ------------------------------------------------------------------ */

// https://drive/connect/<code> answers with the setup Deluxe Docs needs: the
// endpoints on this server and the client id registered for it. The link holds
// nothing secret; signing in still happens on the drive's own pages.
async function serveConnectLink(req, res, code) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'Only reading is allowed here.' });
    return;
  }

  const link = store.docsLinkByCode(code);
  if (!link) {
    sendJson(res, 404, { error: 'That connection link is not here. Make a new one in Deluxe Drive.' });
    return;
  }

  const client = await store.clientById(link.clientId);
  if (!client) {
    sendJson(res, 404, { error: 'That connection link is no longer connected. Make a new one in Deluxe Drive.' });
    return;
  }

  const origin = publicOrigin(req);
  sendJson(res, 200, {
    driveName: SERVER_NAME,
    driveUrl: origin,
    authorizeUrl: `${origin}/oauth/authorize`,
    tokenUrl: `${origin}/oauth/token`,
    userInfoUrl: `${origin}/oauth/userinfo`,
    clientId: client.id,
    redirectUri: client.redirectUri,
    accountId: link.accountId || '',
    scope: 'openid profile drive.read',
  });
}

/* ------------------------------------------------------------------ */
/* Static drive files                                                  */
/* ------------------------------------------------------------------ */

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'Only reading is allowed here.' });
    return;
  }

  const raw = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const segments = raw.split('/').map(decodeSegment);

  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    notFound(res);
    return;
  }

  const relative = segments.join('/');
  const first = segments[0];
  const allowed = STATIC_ALLOWED.has(relative) || (STATIC_ALLOWED_DIRS.has(first) && segments.length > 1);

  if (!allowed) {
    notFound(res);
    return;
  }

  const full = path.resolve(ROOT, relative);
  if (full !== path.join(ROOT, relative) || !full.startsWith(`${ROOT}${path.sep}`)) {
    notFound(res);
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(full);
  } catch (error) {
    notFound(res);
    return;
  }
  if (!stat.isFile()) {
    notFound(res);
    return;
  }

  const extension = path.extname(full).toLowerCase();
  res.writeHead(200, {
    'Content-Type': STATIC_TYPES[extension] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'public, max-age=0, must-revalidate',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = fs.createReadStream(full);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/* ------------------------------------------------------------------ */
/* OAuth endpoints                                                     */
/* ------------------------------------------------------------------ */

async function handleOauth(req, res, url) {
  if (url.pathname === '/oauth/authorize') {
    if (req.method !== 'GET' && req.method !== 'POST') {
      sendJson(res, 405, { error: 'Only GET and POST are allowed here.' });
      return;
    }

    const body = req.method === 'POST' ? await readFormBody(req) : new URLSearchParams();
    const result = await oauth.authorize({ method: req.method, query: url.searchParams, body });

    if (result.redirect) {
      redirect(res, result.redirect);
      return;
    }
    sendHtml(res, result.status || 200, result.html);
    return;
  }

  if (url.pathname === '/oauth/token') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Only POST is allowed here.' });
      return;
    }

    const form = await readFormBody(req);
    const result = await oauth.token(form);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    sendJson(res, result.status || 200, result.json);
    return;
  }

  if (url.pathname === '/oauth/userinfo') {
    const session = sessionOf(req);
    const account = session ? await store.accountById(session.userId) : null;

    if (!session || !account) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    sendJson(res, 200, {
      sub: account.id,
      name: account.name,
      preferred_username: account.name,
      email: '',
      scope: session.scope,
    });
    return;
  }

  notFound(res);
}

/* ------------------------------------------------------------------ */
/* Request handling                                                    */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, url, segments) {
  const match = matchRoute(req.method, segments);

  if (!match) {
    sendJson(res, 404, { error: 'There is nothing at that address.' });
    return;
  }

  await match.handler({ req, res, url, params: match.params });
}

async function handle(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let url;
  let segments;

  try {
    const host = req.headers.host || 'localhost';
    url = new URL(req.url || '/', `http://${host}`);
    segments = url.pathname.split('/').filter(Boolean).map(decodeSegment);

    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url, segments);
      return;
    }

    if (url.pathname.startsWith('/oauth/')) {
      await handleOauth(req, res, url);
      return;
    }

    if (url.pathname.startsWith('/connect/')) {
      await serveConnectLink(req, res, segments[1] || '');
      return;
    }

    if (url.pathname.startsWith('/s/')) {
      await serveShared(req, res, segments[1] || '');
      return;
    }

    await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error('Request failed:', req.method, req.url, error);
    if (!res.headersSent) {
      sendJson(res, error.status || 500, {
        error: error.status ? error.message : 'The drive could not answer that.',
      });
    } else {
      res.end();
    }
  }
}

const server = http.createServer(handle);

server.on('clientError', (error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

store
  .init()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`${SERVER_NAME} server listening on http://${HOST}:${PORT}`);
      console.log(`Files are stored in ${store.dataDir}`);
    });
  })
  .catch((error) => {
    console.error('Deluxe Drive could not start:', error);
    process.exit(1);
  });

function shutdown(signal) {
  console.log(`${signal}: closing the Deluxe Drive server`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
