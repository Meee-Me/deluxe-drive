// Pages for the OAuth sign-in. Pure functions: no storage, no Node APIs.

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
      <form id="login" method="post" action="${escapeHtml(action)}">
        <label>Your name
          <input id="nm" name="name" type="text" value="${escapeHtml(name)}" autocomplete="username" maxlength="24" required />
        </label>
        <label>Password
          <input id="pw" name="password" type="password" autocomplete="current-password" required />
        </label>
        <input id="hs" name="hash" type="hidden" value="" />
        <p class="err" id="lerr"${error ? '' : ' hidden'}>${escapeHtml(error)}</p>
        <button type="submit">Sign in</button>
      </form>
      <p>Your password is turned into a hash in this page and checked here, on Deluxe Drive. It is never sent to ${escapeHtml(client.name)}.</p>
      <noscript><p class="err">Turn on JavaScript to sign in.</p></noscript>
      <script>
      (function () {
        var f = document.getElementById('login');
        var err = document.getElementById('lerr');
        function hex(bytes) { return Array.prototype.map.call(new Uint8Array(bytes), function (b) { return b.toString(16).padStart(2, '0'); }).join(''); }
        function unhex(s) { var o = new Uint8Array(s.length / 2); for (var i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16); return o; }
        function fail(t) { err.textContent = t; err.hidden = false; }
        f.addEventListener('submit', async function (e) {
          if (f.getAttribute('data-ready')) return;
          e.preventDefault();
          var name = document.getElementById('nm').value.trim();
          var pw = document.getElementById('pw').value;
          if (!name || !pw) return;
          try {
            var r = await fetch('/api/accounts/find', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) });
            var acc = await r.json();
            if (!acc || !acc.salt) throw new Error('x');
            var key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), { name: 'PBKDF2' }, false, ['deriveBits']);
            var bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: unhex(acc.salt), iterations: 120000, hash: 'SHA-256' }, key, 256);
            document.getElementById('hs').value = hex(bits);
            document.getElementById('pw').value = '';
            f.setAttribute('data-ready', '1');
            f.submit();
          } catch (x) {
            fail('Could not check the password in this browser. Open the drive over https.');
          }
        });
      })();
      </script>`,
  });
}

function consentPage({ client, account, action, requestId, scope }) {
  let returnsTo = '';
  try { returnsTo = new URL(client.redirectUri).host; } catch (error) { returnsTo = ''; }
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
  <p>You will be sent back to <b>${escapeHtml(returnsTo)}</b>. Allow only if you recognise it.</p>
  <p>Requested: ${escapeHtml(scopes.length ? scopes.join(', ') : 'openid profile')}</p>
</main>
</body>
</html>`;
}

function body_error(error) {
  return error ? `<p class="err">${escapeHtml(error)}</p>` : '';
}

export { escapeHtml, normalizeRedirect, page, errorPage, loginPage, consentPage };
