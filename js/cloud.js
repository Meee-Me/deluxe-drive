// Deluxe Drive, from the browser's side.
//
// Two servers, one sign-in:
//   - Deluxe Main owns the account. "Sign in with Deluxe Main" sends the page
//     there and back; Main hands this page a key for the account. The folder
//     and file list and the drive's settings are saved in Deluxe Main too.
//   - The Deluxe Drive server keeps the file contents and share links. It
//     accepts the same key, after checking it with Deluxe Main.
// No account is ever made in Deluxe Drive.
//
// This module also opens documents in Deluxe Docs, which signs in with Deluxe
// Main by itself.

// Deluxe Main is on Vercel; its /api addresses reach the Deluxe data server.
const DEFAULT_MAIN = 'https://deluxe-main.vercel.app';
const DEFAULT_SERVER = 'https://deluxe-drive.deluxelordd.workers.dev';
// Where Deluxe Docs lives. Opening a document there passes a share link.
export const DOCS_URL = 'https://deluxe-docs-qtp5.vercel.app';

const SESSION_KEY = 'dd.main.session';
const SERVER_KEY = 'dd.server';
const MAIN_KEY = 'dd.main.url';
const DOCS_KEY = 'dd.docs';
const DOCS_DEFAULTS = { url: DOCS_URL, autoOpen: true };
const DATA_APP = 'drive';

const state = {
  server: null,
  base: '',
  main: '',
  session: null,
};

function read(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch (error) {
    return '';
  }
}

function write(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch (error) {
    /* storage can be blocked; this visit still works */
  }
}

export function normalizeServer(value) {
  let raw = String(value || '').trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw.replace(/^\/+/, '')}`;
  let url;
  try {
    url = new URL(raw);
  } catch (error) {
    return null;
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  return url.origin;
}

// Like normalizeServer, but keeps a path such as /main.
function normalizeMain(value) {
  const origin = normalizeServer(value);
  if (!origin) return null;
  try {
    return origin + new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`).pathname.replace(/\/+$/, '');
  } catch (error) {
    return origin;
  }
}

export function mainUrl() {
  return state.main || normalizeMain(read(MAIN_KEY)) || DEFAULT_MAIN;
}

/* ---------------- guests ---------------- */

// A guest uses the drive without an account: files stay in this browser.
// Signing in later moves them into the Deluxe account.
const GUEST_KEY = 'deluxe.guest';

export function isGuest() {
  return !state.session && read(GUEST_KEY) === '1';
}

export function setGuest(on) {
  write(GUEST_KEY, on ? '1' : '');
}

/* ------------------------------------------------------------------ */
/* Which Deluxe Drive server                                           */
/* ------------------------------------------------------------------ */

async function probeAt(base) {
  try {
    const response = await fetch(`${base}/api/health`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data || data.ok !== true || data.server !== true) return null;
    return data;
  } catch (error) {
    return null;
  }
}

// The page's own origin first (served by the drive's Worker, that is the
// server), then an address saved earlier, then the drive on Cloudflare.
export async function detect() {
  if (state.server) return state.server;
  const bases = [''];
  const saved = normalizeServer(read(SERVER_KEY));
  if (saved && saved !== location.origin) bases.push(saved);
  if (!bases.includes(DEFAULT_SERVER) && location.origin !== DEFAULT_SERVER) bases.push(DEFAULT_SERVER);

  for (const base of bases) {
    const found = await probeAt(base);
    if (found) {
      state.base = base;
      state.server = found;
      // The drive server says which Deluxe Main it trusts; use that one.
      if (found.main && !read(MAIN_KEY)) state.main = normalizeMain(found.main) || '';
      return found;
    }
  }
  return null;
}

// Online means the drive server answered and someone is signed in: share
// links, Deluxe Docs and the upload limit only apply then (not to guests).
export function isOnline() {
  return !!state.server && !!state.session;
}

export function serverFound() {
  return !!state.server;
}

export function serverInfo() {
  return state.server;
}

export function serverAddress() {
  return state.base || location.origin;
}

export function uploadLimit() {
  const value = state.server && state.server.limits && Number(state.server.limits.uploadBytes);
  return value > 0 ? value : 0;
}

/* ------------------------------------------------------------------ */
/* Signing in with Deluxe Main                                         */
/* ------------------------------------------------------------------ */

function loadSession() {
  try {
    const value = JSON.parse(read(SESSION_KEY) || 'null');
    if (value && value.token && value.exp > Date.now() && value.main === mainUrl()) return value;
  } catch (error) {
    /* nothing usable */
  }
  return null;
}

function saveSession(value) {
  state.session = value;
  write(SESSION_KEY, value ? JSON.stringify(value) : '');
}

export function currentUser() {
  return state.session ? state.session.user : null;
}

export function isSignedIn() {
  return !!state.session;
}

// Goes to Deluxe Main, which signs the person in (or makes their account) and
// sends them back here with a one-use code.
export function signIn() {
  setGuest(false);
  const back = location.href.replace(/#.*$/, '');
  location.href = `${mainUrl()}/connect?${new URLSearchParams({ return: back, app: DATA_APP })}`;
}

export function accountPage() {
  return `${mainUrl()}/`;
}

// Back from Deluxe Main: trade #deluxe_code=... for this page's key. Then make
// sure the key still works (signing out on Deluxe Main ends it).
export async function restoreSession() {
  state.session = loadSession();
  if (/(?:^#|&)deluxe_guest=1/.test(location.hash || '')) {
    setGuest(true);
    try {
      history.replaceState(history.state, '', location.pathname + location.search);
    } catch (error) {
      /* nothing to tidy */
    }
  }
  const match = /(?:^#|&)deluxe_code=([0-9a-f]{48})/.exec(location.hash || '');
  if (match) {
    try {
      history.replaceState(history.state, '', location.pathname + location.search);
    } catch (error) {
      /* the code is used up anyway */
    }
    const response = await fetch(`${mainUrl()}/api/connect/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: match[1] }),
      credentials: 'omit',
    }).catch(() => null);
    const data = response ? await response.json().catch(() => ({})) : {};
    if (!response || !response.ok) throw new Error(data.error || 'Deluxe Main could not be reached. Try signing in again.');
    saveSession({ token: data.token, user: data.user, exp: Date.now() + data.expiresIn * 1000, main: mainUrl() });
    setGuest(false);
    return state.session.user;
  }
  if (!state.session) return null;
  try {
    const me = await mainJson('/api/auth/me');
    state.session.user = me.user;
    // Each visit renews the saved sign-in.
    if (me.expiresIn) state.session.exp = Date.now() + me.expiresIn * 1000;
    saveSession(state.session);
  } catch (error) {
    if (error.status === 401) return null;
    // Main unreachable for a moment: keep the key and try to carry on.
  }
  return state.session ? state.session.user : null;
}

export async function signOut() {
  const token = state.session && state.session.token;
  saveSession(null);
  setGuest(false);
  if (token) {
    await fetch(`${mainUrl()}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'omit',
    }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Talking to the servers                                              */
/* ------------------------------------------------------------------ */

async function send(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.session) headers.Authorization = `Bearer ${state.session.token}`;
  let response;
  try {
    response = await fetch(url, { ...options, headers, cache: 'no-store', credentials: 'omit' });
  } catch (error) {
    const failure = new Error('The server could not be reached. Check your connection.');
    failure.offline = true;
    throw failure;
  }
  // A key Deluxe Main no longer knows is dropped, so the next visit signs in again.
  if (response.status === 401 && state.session) saveSession(null);
  return response;
}

async function asJson(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error((data && data.error) || `The server answered ${response.status}.`);
    error.status = response.status;
    error.code = data && data.code;
    throw error;
  }
  return data || {};
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const driveCall = (path, options) => send(`${state.base}${path}`, options);
const driveJson = async (path, options) => asJson(await driveCall(path, options));
const mainJson = async (path, options) => asJson(await send(`${mainUrl()}${path}`, options));
const dataPath = (key) => `/api/data/${DATA_APP}${key === undefined ? '' : `/${encodeURIComponent(key)}`}`;

/* ------------------------------------------------------------------ */
/* The drive's storage, with the same shape as db.js                   */
/* ------------------------------------------------------------------ */

// The file list and settings live in Deluxe Main ("node:<id>", "set:<key>");
// the file contents live in the Deluxe Drive server.
export const remote = {
  async allNodes() {
    const data = await mainJson(`${dataPath()}?prefix=node:`);
    return (data.items || []).map((item) => item.value).filter((node) => node && node.id);
  },

  async getNode(id) {
    const response = await send(`${mainUrl()}${dataPath(`node:${id}`)}`);
    if (!response.ok) return undefined;
    const data = await response.json().catch(() => null);
    return data ? data.value : undefined;
  },

  async putNode(node) {
    await mainJson(dataPath(`node:${node.id}`), { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ value: node }) });
  },

  async putNodes(nodes) {
    for (let index = 0; index < nodes.length; index += 500) {
      const put = nodes.slice(index, index + 500).map((node) => ({ key: `node:${node.id}`, value: node }));
      await mainJson(`${dataPath()}/batch`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ put }) });
    }
  },

  async deleteNode(id) {
    await mainJson(dataPath(`node:${id}`), { method: 'DELETE' });
  },

  async getBlob(id) {
    const response = await driveCall(`/api/db/blobs/${encodeURIComponent(id)}`);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error('That file could not be read from Deluxe Drive.');
    return { id, blob: await response.blob() };
  },

  async putBlob(id, blob) {
    const headers = { 'Content-Type': (blob && blob.type) || 'application/octet-stream' };
    if (blob && blob.name) headers['X-Deluxe-Name'] = encodeURIComponent(blob.name);
    const response = await driveCall(`/api/db/blobs/${encodeURIComponent(id)}`, { method: 'PUT', headers, body: blob });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error((data && data.error) || 'That file could not be stored in Deluxe Drive.');
    }
    return true;
  },

  async deleteBlob(id) {
    await driveJson(`/api/db/blobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async getSetting(key) {
    const response = await send(`${mainUrl()}${dataPath(`set:${key}`)}`);
    if (!response.ok) return undefined;
    const data = await response.json().catch(() => null);
    return data && 'value' in data ? { key, value: data.value } : undefined;
  },

  async putSetting(key, value) {
    await mainJson(dataPath(`set:${key}`), { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ value }) });
  },

  async deleteSetting(key) {
    await mainJson(dataPath(`set:${key}`), { method: 'DELETE' });
  },

  // "Erase my files": the contents in Deluxe Drive, then the list in Deluxe Main.
  async clearAll() {
    await driveJson('/api/db/clear', { method: 'POST' });
    await mainJson(dataPath(), { method: 'DELETE' });
  },
};

// A drive used before Deluxe Main existed kept its file list on the Deluxe
// Drive server. The first time its owner signs in, that list moves to Deluxe
// Main (the files themselves stay where they are). Returns how many moved.
export async function moveOldFileList() {
  let old;
  try {
    old = await driveJson('/api/legacy/data');
  } catch (error) {
    return 0;
  }
  const nodes = Array.isArray(old.nodes) ? old.nodes : [];
  const settings = Array.isArray(old.settings) ? old.settings : [];
  if (!nodes.length && !settings.length) return 0;
  const existing = await remote.allNodes();
  const have = new Set(existing.map((node) => node.id));
  await remote.putNodes(nodes.filter((node) => node && node.id && !have.has(node.id)));
  for (const item of settings) await remote.putSetting(item.key, item.value);
  await driveJson('/api/legacy/data/done', { method: 'POST' });
  return nodes.length;
}

/* ------------------------------------------------------------------ */
/* Share links                                                         */
/* ------------------------------------------------------------------ */

export async function shareFile(id, name) {
  return driveJson(`/api/files/${encodeURIComponent(id)}/share`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: name || '' }),
  });
}

export async function stopSharing(id) {
  await driveJson(`/api/files/${encodeURIComponent(id)}/share`, { method: 'DELETE' });
}

export async function listShares() {
  const data = await driveJson('/api/files/shares');
  return Array.isArray(data.shares) ? data.shares : [];
}

export async function directLink(node) {
  const share = await shareFile(node.id, node.name);
  return share.url;
}

/* ------------------------------------------------------------------ */
/* Deluxe Docs                                                         */
/* ------------------------------------------------------------------ */

export function docsSettings() {
  try {
    const parsed = JSON.parse(read(DOCS_KEY) || 'null');
    if (!parsed) return { ...DOCS_DEFAULTS };
    return { url: typeof parsed.url === 'string' && parsed.url ? parsed.url : DOCS_URL, autoOpen: parsed.autoOpen !== false };
  } catch (error) {
    return { ...DOCS_DEFAULTS };
  }
}

export function saveDocsSettings(next) {
  const value = { url: typeof next.url === 'string' && next.url ? next.url : DOCS_URL, autoOpen: next.autoOpen !== false };
  write(DOCS_KEY, JSON.stringify(value));
  return value;
}

export function docsReady() {
  return !!docsSettings().url && isOnline();
}

function viewerUrl(fileUrl, name) {
  let target;
  try {
    target = new URL(docsSettings().url);
  } catch (error) {
    return null;
  }
  target.searchParams.set('url', fileUrl);
  if (name) target.searchParams.set('name', name);
  return target.toString();
}

// Opens a file in Deluxe Docs through a share link, so Docs can read it even
// before it is signed in. The tab opens first so the browser counts the click.
export async function openInDocs(node) {
  if (!isOnline()) throw new Error('Deluxe Docs needs the Deluxe Drive server.');
  const tab = window.open('about:blank', '_blank');
  try {
    const share = await shareFile(node.id, node.name);
    const url = viewerUrl(share.url, node.name);
    if (!url) throw new Error('The Deluxe Docs address is not valid.');
    if (tab) tab.location.href = url;
    else location.href = url;
    return url;
  } catch (error) {
    if (tab) {
      try {
        tab.close();
      } catch (closeError) {
        /* the tab may already be gone */
      }
    }
    throw error;
  }
}

// Where Deluxe Convert lives. "Convert with Deluxe Convert" opens it with the
// file already added (through a share link, so Convert needs nothing else).
export const CONVERT_URL = 'https://deluxe-convert.vercel.app';

export async function openInConvert(node) {
  if (!isOnline()) throw new Error('Sign in to send files to Deluxe Convert.');
  const tab = window.open('about:blank', '_blank');
  try {
    const share = await shareFile(node.id, node.name);
    const target = new URL(CONVERT_URL);
    target.searchParams.set('url', share.url);
    target.searchParams.set('name', node.name);
    if (tab) tab.location.href = target.toString();
    else location.href = target.toString();
  } catch (error) {
    if (tab) {
      try {
        tab.close();
      } catch (closeError) {
        /* already gone */
      }
    }
    throw error;
  }
}

export function storageLabel() {
  return 'Deluxe Drive (files) and Deluxe Main (everything else)';
}
