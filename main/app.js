// Deluxe Main's page: sign in, create an account, continue to a Deluxe website,
// and the account home with every Deluxe website.
//
// The password never leaves this page: it is hashed here (PBKDF2-SHA256 with the
// account's salt, the same way Deluxe Drive always did, so older Drive accounts
// still sign in) and only that hash is sent.

const SESSION_KEY = 'deluxe.main.session';
const API = String(window.DELUXE_MAIN_API || '').replace(/\/+$/, '');
const ITERATIONS = 120000;
const $ = (selector) => document.querySelector(selector);

let session = loadSession();
let creating = false;
const params = new URLSearchParams(location.search);
const connecting = /\/connect$/.test(location.pathname.replace(/\/+$/, '')) && params.get('return');
let connectInfo = null;

/* ---------------- helpers ---------------- */

function loadSession() {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (value && value.token && value.exp > Date.now()) return value;
  } catch (error) {
    /* storage blocked */
  }
  return null;
}

function saveSession(value) {
  session = value;
  try {
    if (value) localStorage.setItem(SESSION_KEY, JSON.stringify(value));
    else localStorage.removeItem(SESSION_KEY);
  } catch (error) {
    /* storage blocked: signed in for this visit only */
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (session) headers.Authorization = `Bearer ${session.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  } catch (error) {
    throw new Error('Deluxe Main could not be reached. Check your connection.');
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && session && !path.startsWith('/api/auth/login')) {
    if (data.code === 'unauthorized') saveSession(null);
  }
  if (!response.ok) {
    const error = new Error(data.error || `Deluxe Main answered ${response.status}.`);
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
function fromHex(value) {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const makeSalt = () => hex(crypto.getRandomValues(new Uint8Array(16)));
async function hashPassword(password, salt) {
  if (!window.crypto || !crypto.subtle) throw new Error('This browser cannot hash passwords securely. Open Deluxe Main over https.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: fromHex(salt), iterations: ITERATIONS, hash: 'SHA-256' }, key, 256);
  return hex(new Uint8Array(bits));
}
async function hashFor(name, password) {
  const { salt } = await api('/api/accounts/find', { method: 'POST', body: { name } });
  return hashPassword(password, salt);
}

function show(id) {
  for (const section of ['loading', 'auth', 'connect', 'home']) $(`#${section}`).hidden = section !== id;
  const user = session && session.user;
  $('#top-user').hidden = !user || id === 'home';
  if (user) $('#top-user').textContent = `Signed in as ${user.name}`;
}

function setError(el, message) {
  el.textContent = message || '';
  el.hidden = !message;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// A small form in a dialog. Resolves with the field values, or null.
function ask({ title, text = '', fields = [], ok = 'OK', danger = false, submit }) {
  const dialog = $('#dialog');
  $('#dialog-title').textContent = title;
  $('#dialog-text').textContent = text;
  $('#dialog-text').hidden = !text;
  const box = $('#dialog-fields');
  box.innerHTML = '';
  const inputs = fields.map((field) => {
    const label = document.createElement('label');
    label.textContent = field.label;
    const input = document.createElement('input');
    input.type = field.type || 'text';
    input.value = field.value || '';
    if (field.autocomplete) input.autocomplete = field.autocomplete;
    label.append(input);
    box.append(label);
    return input;
  });
  const okButton = $('#dialog-ok');
  okButton.textContent = ok;
  okButton.className = `btn ${danger ? 'danger' : 'primary'}`;
  setError($('#dialog-error'), '');

  return new Promise((resolve) => {
    const form = $('#dialog-form');
    const finish = (value) => {
      form.onsubmit = null;
      $('#dialog-cancel').onclick = null;
      dialog.close();
      resolve(value);
    };
    form.onsubmit = async (event) => {
      event.preventDefault();
      const values = inputs.map((input) => input.value);
      okButton.disabled = true;
      try {
        if (submit) await submit(values);
        finish(values);
      } catch (error) {
        setError($('#dialog-error'), error.message);
      } finally {
        okButton.disabled = false;
      }
    };
    $('#dialog-cancel').onclick = () => finish(null);
    dialog.oncancel = () => finish(null);
    dialog.showModal();
    if (inputs[0]) inputs[0].focus();
  });
}

/* ---------------- sign in / create account ---------------- */

function drawAuth() {
  $('#auth-title').textContent = creating ? 'Create your Deluxe account' : 'Sign in';
  $('#auth-submit').textContent = creating ? 'Create account' : 'Sign in';
  $('#auth-confirm-row').hidden = !creating;
  $('#auth-hint').hidden = !creating;
  $('#auth-password').autocomplete = creating ? 'new-password' : 'current-password';
  $('#auth-switch-text').textContent = creating ? 'Already have an account?' : 'New here?';
  $('#auth-switch').textContent = creating ? 'Sign in' : 'Create a Deluxe account';
  $('#auth-lead').textContent = creating
    ? 'Deluxe accounts are made only here. Use it to sign in to every Deluxe website.'
    : 'One Deluxe account for every Deluxe website. Older Deluxe Drive accounts sign in here too.';
}

$('#auth-switch').onclick = () => {
  creating = !creating;
  setError($('#auth-error'), '');
  drawAuth();
};

$('#auth-form').onsubmit = async (event) => {
  event.preventDefault();
  const name = $('#auth-name').value.trim().replace(/\s+/g, ' ');
  const password = $('#auth-password').value;
  const error = $('#auth-error');
  setError(error, '');
  if (!name || !password) return setError(error, 'Type your name and password.');
  if (creating) {
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{1,22}[A-Za-z0-9]$/.test(name)) {
      return setError(error, 'Use 3 to 24 letters, numbers, spaces, dots, dashes or underscores for the name.');
    }
    if (password.length < 8) return setError(error, 'Use at least 8 characters for the password.');
    if (password !== $('#auth-confirm').value) return setError(error, 'The two passwords are not the same.');
  }

  const submit = $('#auth-submit');
  submit.disabled = true;
  submit.textContent = creating ? 'Creating…' : 'Signing in…';
  try {
    let data;
    if (creating) {
      const salt = makeSalt();
      data = await api('/api/accounts', { method: 'POST', body: { name, salt, hash: await hashPassword(password, salt) } });
    } else {
      data = await api('/api/auth/login', { method: 'POST', body: { name, hash: await hashFor(name, password) } });
    }
    saveSession({ token: data.token, user: data.user, exp: Date.now() + data.expiresIn * 1000 });
    $('#auth-password').value = '';
    $('#auth-confirm').value = '';
    await route();
  } catch (failure) {
    setError(error, failure.message);
  } finally {
    submit.disabled = false;
    drawAuth();
  }
};

/* ---------------- continue to a website ---------------- */

async function drawConnect() {
  const error = $('#connect-error');
  setError(error, '');
  try {
    connectInfo = await api('/api/connect/check', { method: 'POST', body: { return: params.get('return'), app: params.get('app') || '' } });
  } catch (failure) {
    if (!session) return route();
    $('#connect-title').textContent = 'This website cannot use Deluxe Main';
    $('#connect-lead').textContent = '';
    setError(error, failure.message);
    $('#connect-go').hidden = true;
    show('connect');
    return;
  }
  // A website this account already said yes to continues straight away.
  if (connectInfo.approved) return approve();
  $('#connect-dot').textContent = connectInfo.name.replace(/^Deluxe\s+/, '').slice(0, 1);
  $('#connect-title').textContent = `Continue to ${connectInfo.name}`;
  $('#connect-lead').textContent = `${connectInfo.name} (${connectInfo.origin.replace(/^https?:\/\//, '')}) will know your name and keep what it saves for you in your Deluxe account. Signed in as ${session.user.name}.`;
  $('#connect-go').hidden = false;
  show('connect');
}

async function approve() {
  const button = $('#connect-go');
  button.disabled = true;
  try {
    const { redirect } = await api('/api/connect/approve', { method: 'POST', body: { return: params.get('return'), app: params.get('app') || '' } });
    location.replace(redirect);
  } catch (failure) {
    button.disabled = false;
    setError($('#connect-error'), failure.message);
    show('connect');
  }
}

$('#connect-go').onclick = approve;
$('#connect-other').onclick = async () => {
  await signOut();
  route();
};
// Back to the website without an account: it keeps what you do in that browser.
function continueAsGuest() {
  try {
    const back = new URL(params.get('return'));
    back.hash = 'deluxe_guest=1';
    location.href = back.toString();
  } catch (error) {
    location.href = './';
  }
}
$('#connect-cancel').onclick = continueAsGuest;
$('#auth-guest').onclick = continueAsGuest;

/* ---------------- home ---------------- */

async function drawHome() {
  let account;
  try {
    account = await api('/api/account');
  } catch (failure) {
    if (!session) return route();
    $('#home-title').textContent = 'Deluxe Main could not load your account';
    $('#home-lead').textContent = failure.message;
    show('home');
    return;
  }
  session.user = account.user;
  session.exp = Date.now() + 180 * 24 * 60 * 60 * 1000;
  saveSession(session);
  $('#home-title').textContent = `Hello, ${account.user.name}`;
  $('#acct-name').textContent = account.user.name;
  $('#acct-handle').textContent = `${account.user.handle}@deluxemail.com`;
  const total = account.usage.reduce((sum, row) => sum + Number(row.bytes || 0), 0);
  $('#acct-usage').textContent = account.usage.length
    ? `${formatBytes(total)} across ${account.usage.length} website${account.usage.length === 1 ? '' : 's'} (files are counted in Deluxe Drive)`
    : 'Nothing saved yet';

  const apps = $('#apps');
  apps.innerHTML = '';
  for (const app of account.apps) {
    const link = document.createElement('a');
    link.className = `app${app.url ? '' : ' off'}`;
    if (app.url) link.href = app.url;
    link.target = '_blank';
    link.rel = 'noopener';
    const dot = document.createElement('span');
    dot.className = 'app-dot';
    dot.textContent = app.name.replace(/^Deluxe\s+/, '').slice(0, 1);
    const text = document.createElement('div');
    const title = document.createElement('b');
    title.textContent = app.name;
    const about = document.createElement('span');
    about.className = 'muted';
    about.textContent = app.url ? app.about : 'Address not set yet';
    text.append(title, about);
    link.append(dot, text);
    apps.append(link);
  }

  const list = $('#sessions');
  list.innerHTML = '';
  if (!account.signedIn.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.style.padding = '14px 0';
    empty.textContent = 'None yet. Open a Deluxe website and tap Sign in with Deluxe Main.';
    list.append(empty);
  }
  for (const entry of account.signedIn) {
    const row = document.createElement('div');
    row.className = 'row';
    const text = document.createElement('div');
    const title = document.createElement('b');
    title.textContent = entry.name;
    const seen = document.createElement('p');
    seen.className = 'muted';
    seen.textContent = entry.lastSeen ? `Last used ${new Date(entry.lastSeen).toLocaleString()}` : '';
    text.append(title, seen);
    const button = document.createElement('button');
    button.className = 'btn';
    button.type = 'button';
    button.textContent = 'Sign out';
    button.onclick = async () => {
      button.disabled = true;
      try {
        await api(`/api/account/sessions/${encodeURIComponent(entry.app)}`, { method: 'DELETE' });
        drawHome();
      } catch (failure) {
        button.disabled = false;
        alert(failure.message);
      }
    };
    row.append(text, button);
    list.append(row);
  }
  show('home');
}

$('#acct-rename').onclick = () =>
  ask({
    title: 'Change your name',
    text: 'Your Deluxe Mail address stays the same.',
    fields: [{ label: 'Name', value: session.user.name }],
    ok: 'Save',
    submit: async ([name]) => {
      await api('/api/account', { method: 'PATCH', body: { name } });
    },
  }).then((done) => done && drawHome());

$('#acct-password').onclick = () =>
  ask({
    title: 'Change your password',
    fields: [
      { label: 'Current password', type: 'password', autocomplete: 'current-password' },
      { label: 'New password (8 or more characters)', type: 'password', autocomplete: 'new-password' },
      { label: 'New password again', type: 'password', autocomplete: 'new-password' },
    ],
    ok: 'Change password',
    submit: async ([current, next, again]) => {
      if (next.length < 8) throw new Error('Use at least 8 characters.');
      if (next !== again) throw new Error('The two new passwords are not the same.');
      const currentHash = await hashFor(session.user.name, current);
      const salt = makeSalt();
      await api('/api/account/password', { method: 'POST', body: { currentHash, salt, hash: await hashPassword(next, salt) } });
    },
  }).then((done) => done && drawHome());

$('#acct-delete').onclick = () =>
  ask({
    title: 'Delete your Deluxe account?',
    text: 'This deletes the account, everything every Deluxe website saved for it, and all its files in Deluxe Drive. It cannot be undone.',
    fields: [{ label: 'Type your password to confirm', type: 'password', autocomplete: 'current-password' }],
    ok: 'Delete everything',
    danger: true,
    submit: async ([password]) => {
      const hash = await hashFor(session.user.name, password);
      await api('/api/account/delete', { method: 'POST', body: { hash } });
    },
  }).then((done) => {
    if (!done) return;
    saveSession(null);
    route();
  });

async function signOut() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch (error) {
    /* signed out here either way */
  }
  saveSession(null);
}

$('#sign-out').onclick = async () => {
  await signOut();
  route();
};

/* ---------------- which screen ---------------- */

async function route() {
  if (!session) {
    $('#auth-for').hidden = !connecting;
    $('#auth-guest').hidden = !connecting;
    if (connecting) {
      let site = 'a Deluxe website';
      try {
        site = new URL(params.get('return')).host;
      } catch (error) {
        /* shown as "a Deluxe website" */
      }
      $('#auth-for').textContent = `Sign in to continue to ${site}`;
    }
    drawAuth();
    show('auth');
    return;
  }
  if (connecting) return drawConnect();
  return drawHome();
}

route();
