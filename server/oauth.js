'use strict';

// OAuth 2.0 (authorization code + PKCE) for viewers such as Deluxe Docs.
//
// Deluxe Docs sends the reader here when it needs access, and the pages below
// ask that person for their Deluxe Drive password on this origin, so the
// password never travels to the other site. The token that comes out is the
// same kind of token the drive itself uses, and it opens only the files.

const crypto = require('node:crypto');
const store = require('./store');

const SESSION_SCOPE = 'profile drive.read';

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

// A viewer's return address has to be compared the way browsers and the
// viewer itself see it: same origin and path, ignoring a trailing slash.
function normalizeRedirect(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const path = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.origin}${path}`;
  } catch (error) {
    return null;
  }
}

function page({ title, body, tone = '' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)} · Deluxe Drive</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7fb; --surface: #ffffff; --text: #1b1b1f; --muted: #5c5f6b; --border: #dcdde5; --accent: #4f46e5; --danger: #b42318; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #131314; --surface: #1b1b1d; --text: #eceff4; --muted: #a9adb8; --border: #2c2d31; --accent: #8b87f6; --danger: #ff8b7d; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
    background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { width: 100%; max-width: 400px; background: var(--surface); border: 1px solid var(--border); border-radius: 20px;
    padding: 24px; display: flex; flex-direction: column; gap: 14px; box-shadow: 0 16px 48px rgba(0,0,0,.14); }
  .mark { display: flex; align-items: center; gap: 10px; }
  .mark img { width: 34px; height: 34px; border-radius: 9px; }
  .mark span { font-weight: 600; font-size: 15px; }
  h1 { margin: 0; font-size: 19px; line-height: 1.3; }
  p { margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--muted); }
  p b { color: var(--text); font-weight: 600; }
  label { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; color: var(--muted); font-weight: 600; }
  input { height: 44px; padding: 0 12px; border-radius: 11px; border: 1px solid var(--border); background: var(--bg);
    color: var(--text); font-size: 15px; outline: none; }
  input:focus { border-color: var(--accent); background: var(--surface); }
  .row { display: flex; gap: 8px; }
  button { flex: 1; height: 44px; border: none; border-radius: 11px; font-size: 15px; font-weight: 600;
    background: var(--accent); color: #fff; cursor: pointer; }
  button.ghost { background: transparent; border: 1px solid var(--border); color: var(--text); font-weight: 500; }
  .err { color: var(--danger); font-size: 13px; margin: 0; }
  .scope { margin: 0; padding: 0 0 0 18px; color: var(--muted); font-size: 13px; line-height: 1.6; }
  .foot { font-size: 11.5px; color: var(--muted); text-align: center; }
  ${tone}
</style>
</head>
<body>
<main>
  <div class="mark"><img src="/icon.svg" alt="" /><span>Deluxe Drive</span></div>
  ${body}
</main>
</body>
</html>`;
}

function errorPage(title, message) {
  return page({
    title,
    body: `<h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>`,
  });
}

function loginPage({ client, action, error, name = '' }) {
  return page({
    title: 'Sign in',
    body: `
      <h1>Sign in to Deluxe Drive</h1>
      <p><b>${escapeHtml(client.name)}</b> wants to open documents from your drive.</p>
      <form method="post" action="${escapeHtml(action)}">
        <label>Your name
          <input name="name" type="text" value="${escapeHtml(name)}" autocomplete="username" maxlength="24" required />
        </label>
        <label>Password
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        ${body_error(error)}
        <button type="submit">Sign in</button>
      </form>
      <p>Your password is checked here, on Deluxe Drive, and is never sent to ${escapeHtml(client.name)}.</p>`,
  });
}

function consentPage({ client, account, action, requestId, scope }) {
  const scopes = String(scope || '')
    .split(/[\s,]+/)
    .filter(Boolean);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Allow ${escapeHtml(account.name)} · Deluxe Drive</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7fb; --surface: #ffffff; --text: #1b1b1f; --muted: #5c5f6b; --border: #dcdde5; --accent: #4f46e5; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #131314; --surface: #1b1b1d; --text: #eceff4; --muted: #a9adb8; --border: #2c2d31; --accent: #8b87f6; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
    background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { width: 100%; max-width: 400px; background: var(--surface); border: 1px solid var(--border); border-radius: 20px;
    padding: 24px; display: flex; flex-direction: column; gap: 14px; box-shadow: 0 16px 48px rgba(0,0,0,.14); }
  .mark { display: flex; align-items: center; gap: 10px; }
  .mark img { width: 34px; height: 34px; border-radius: 9px; }
  h1 { margin: 0; font-size: 19px; }
  p { margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--muted); }
  p b { color: var(--text); font-weight: 600; }
  ul { margin: 0; padding: 0 0 0 18px; color: var(--muted); font-size: 13px; line-height: 1.6; }
  .row { display: flex; gap: 8px; }
  button { flex: 1; height: 44px; border: none; border-radius: 11px; font-size: 15px; font-weight: 600;
    background: var(--accent); color: #fff; cursor: pointer; }
  button.ghost { background: transparent; border: 1px solid var(--border); color: var(--text); font-weight: 500; }
</style>
</head>
<body>
<main>
  <div class="mark"><img src="/icon.svg" alt="" /><span>Deluxe Drive</span></div>
  <h1>Allow <b>${escapeHtml(client.name)}</b> to open your documents?</h1>
  <p>You are signed in as <b>${escapeHtml(account.name)}</b>.</p>
  <ul>
    <li>It can read the files you open from Deluxe Drive.</li>
    <li>It cannot change, move or delete anything in your drive.</li>
  </ul>
  <form method="post" action="${escapeHtml(action)}">
    <input type="hidden" name="request" value="${escapeHtml(requestId)}" />
    <div class="row">
      <button class="ghost" type="submit" name="decision" value="deny">Cancel</button>
      <button type="submit" name="decision" value="approve">Allow</button>
    </div>
  </form>
  <p>Requested: ${escapeHtml(scopes.length ? scopes.join(', ') : 'openid profile')}</p>
</main>
</body>
</html>`;
}

function body_error(error) {
  return error ? `<p class="err">${escapeHtml(error)}</p>` : '';
}

function redirectBack(redirectUri, params) {
  let url;
  try {
    url = new URL(redirectUri);
  } catch (error) {
    return { status: 400, html: errorPage('That return address is not valid', 'Start again from the app.') };
  }

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  return { status: 302, redirect: url.toString() };
}

async function authorize({ method, query, body }) {
  const clientId = String(query.get('client_id') || '');
  const redirectUri = String(query.get('redirect_uri') || '');
  const state = String(query.get('state') || '');
  const scope = String(query.get('scope') || 'openid profile');
  const challenge = String(query.get('code_challenge') || '');
  const challengeMethod = String(query.get('code_challenge_method') || 'S256').toUpperCase();

  const client = await store.clientById(clientId);
  if (!client) {
    return {
      status: 400,
      html: errorPage(
        'This app is not connected',
        'Deluxe Drive does not know this app. Connect Deluxe Docs again from the Deluxe Drive account menu.'
      ),
    };
  }

  const registered = normalizeRedirect(client.redirectUri);
  const asked = normalizeRedirect(redirectUri);
  if (!registered || !asked || registered !== asked) {
    return {
      status: 400,
      html: errorPage(
        'The return address does not match',
        `“${client.name}” asked to return to a page that is not the one connected to this drive.`
      ),
    };
  }

  if (String(query.get('response_type') || '') !== 'code') {
    return redirectBack(redirectUri, { error: 'unsupported_response_type', state });
  }

  if (!challenge) {
    return redirectBack(redirectUri, {
      error: 'invalid_request',
      error_description: 'A code challenge is required',
      state,
    });
  }

  if (challengeMethod !== 'S256' && challengeMethod !== 'PLAIN') {
    return redirectBack(redirectUri, {
      error: 'invalid_request',
      error_description: 'Unsupported code challenge method',
      state,
    });
  }

  const action = `/oauth/authorize?${query.toString()}`;

  if (method !== 'POST') {
    return { status: 200, html: loginPage({ client, action, error: '' }) };
  }

  const requestId = String(body.get('request') || '');
  if (requestId) {
    const pending = store.takePendingLogin(requestId);
    if (!pending || pending.clientId !== clientId) {
      return {
        status: 400,
        html: errorPage('That sign-in expired', 'Start again from Deluxe Docs to open a document.'),
      };
    }

    if (String(body.get('decision') || '') !== 'approve') {
      return redirectBack(redirectUri, { error: 'access_denied', state });
    }

    const code = store.issueCode({
      userId: pending.userId,
      userName: pending.userName,
      clientId,
      redirectUri,
      scope,
      challenge,
      challengeMethod,
    });

    return redirectBack(redirectUri, { code, state });
  }

  const name = String(body.get('name') || '').trim();
  const password = String(body.get('password') || '');
  const account = name ? await store.accountByName(name) : null;

  let matches = false;
  if (account) {
    try {
      matches = store.safeEqual(account.hash, store.hashPassword(password, account.salt));
    } catch (error) {
      matches = false;
    }
  }

  if (!matches) {
    return {
      status: 401,
      html: loginPage({
        client,
        action,
        name,
        error: 'That name and password do not match an account on this drive.',
      }),
    };
  }

  const pendingId = store.createPendingLogin({
    userId: account.id,
    userName: account.name,
    clientId,
    redirectUri,
    scope,
    state,
    challenge,
    challengeMethod,
  });

  return { status: 200, html: consentPage({ client, account, action, requestId: pendingId, scope }) };
}

async function token(form) {
  const grantType = String(form.get('grant_type') || '');
  if (grantType !== 'authorization_code') {
    return { status: 400, json: { error: 'unsupported_grant_type' } };
  }

  const code = String(form.get('code') || '');
  const clientId = String(form.get('client_id') || '');
  const redirectUri = String(form.get('redirect_uri') || '');
  const verifier = String(form.get('code_verifier') || '');

  const entry = store.codeByValue(code);
  if (!entry) return { status: 400, json: { error: 'invalid_grant' } };

  const fail = () => {
    store.dropCode(code);
    return { status: 400, json: { error: 'invalid_grant' } };
  };

  if (!clientId || entry.clientId !== clientId) return fail();

  const client = await store.clientById(clientId);
  if (!client) return fail();

  if (normalizeRedirect(client.redirectUri) !== normalizeRedirect(redirectUri) || !normalizeRedirect(redirectUri)) {
    return fail();
  }

  if (!verifier) return fail();

  const expected =
    entry.challengeMethod === 'PLAIN'
      ? verifier
      : base64Url(crypto.createHash('sha256').update(verifier).digest());

  if (expected !== entry.challenge) return fail();

  store.dropCode(code);

  const session = store.createSession(entry.userId, {
    clientId,
    scope: entry.scope,
    ttlSeconds: 3600,
  });

  return {
    status: 200,
    json: {
      access_token: session.token,
      token_type: 'Bearer',
      expires_in: session.expiresIn,
      scope: entry.scope || 'openid profile',
    },
  };
}

module.exports = {
  SESSION_SCOPE,
  authorize,
  token,
  normalizeRedirect,
  escapeHtml,
  errorPage,
};
