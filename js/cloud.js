// The Deluxe Drive server, from the browser's side.
//
// When the page is served by the drive's own server (/api/health answers),
// the drive keeps its accounts and files there instead of in this browser's
// IndexedDB, so the same drive opens on another device and files can be
// shared. Served as plain files somewhere else (Netlify, GitHub Pages), every
// call here fails quietly and the drive keeps working exactly as before.
//
// This module also holds the Deluxe Docs connection: connecting a viewer,
// making a share link for a file, and opening that file in the viewer.

import { db as localDb } from './db.js';

const DOCS_KEY = 'dd.docs';
const DOCS_DEFAULTS = { url: '', clientId: '', autoOpen: true };

const state = {
  server: null,
  token: null,
  user: null,
};

/* ------------------------------------------------------------------ */
/* Talking to the server                                               */
/* ------------------------------------------------------------------ */

// One question to the drive's own server. A cookie-gated host (a private
// preview, a site behind an access page) only answers when the page's own
// cookies go along, so this is always a same-origin request with credentials,
// never a bare one: a bare one gets that host's HTML gate instead of JSON,
// which reads as "there is no server" and quietly turns the server off.
async function probe() {
  try {
    const response = await fetch('/api/health', {
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

export async function detect() {
  if (state.server) return state.server;

  const found = await probe();
  if (found) state.server = found;
  return found;
}

// Ask again, for a copy whose first check ran before the server answered.
export async function refreshServer() {
  const found = await probe();
  if (found) state.server = found;
  return state.server || null;
}

export function isOnline() {
  return !!state.server;
}

export function serverInfo() {
  return state.server;
}

export function isSignedIn() {
  return !!state.token;
}

export function currentUser() {
  return state.user;
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (error) {
    const failure = new Error('The Deluxe Drive server could not be reached.');
    failure.offline = true;
    throw failure;
  }

  // A token the server no longer knows (it restarted, or it expired) must not
  // keep being sent: drop it so the next sign-in starts clean.
  if (response.status === 401 && state.token) {
    state.token = null;
    state.user = null;
  }

  return response;
}

async function bodyOf(response) {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

async function requestJson(path, options = {}) {
  const response = await request(path, options);
  const data = await bodyOf(response);

  if (!response.ok) {
    const error = new Error((data && data.error) || `The drive server answered ${response.status}.`);
    error.status = response.status;
    error.code = data && data.code;
    throw error;
  }

  return data || {};
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/* ------------------------------------------------------------------ */
/* Accounts and the session                                            */
/* ------------------------------------------------------------------ */

export async function findAccount(name) {
  return requestJson('/api/accounts/find', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  });
}

export async function accountById(id) {
  const response = await request(`/api/accounts/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Could not read that account.');
  return response.json();
}

// The password is hashed in the browser and only the hash is sent, the same
// way the server stores it.
export async function startSession(user) {
  const data = await requestJson('/api/auth/session', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ userId: user.id, hash: user.hash }),
  });

  state.token = data.token;
  state.user = data.user || { id: user.id, name: user.name };
  return state.user;
}

export async function createAccount(record) {
  const data = await requestJson('/api/accounts', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: record.name, salt: record.salt, hash: record.hash }),
  });

  state.token = data.token;
  state.user = data.user || { id: record.name, name: record.name };
  return state.user;
}

export async function changePassword({ id, currentHash, salt, hash }) {
  await requestJson(`/api/accounts/${encodeURIComponent(id)}/password`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ currentHash, salt, hash }),
  });
}

export async function deleteAccount(id) {
  await requestJson(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  endSession();
}

export function endSession() {
  state.token = null;
  state.user = null;
}

/* ------------------------------------------------------------------ */
/* The drive's storage, with the same shape as db.js                   */
/* ------------------------------------------------------------------ */

export const remote = {
  async allNodes() {
    const data = await requestJson('/api/db/nodes');
    return Array.isArray(data.nodes) ? data.nodes : [];
  },

  async getNode(id) {
    const response = await request(`/api/db/nodes/${encodeURIComponent(id)}`);
    if (!response.ok) return undefined;
    const data = await bodyOf(response);
    return data && data.node ? data.node : undefined;
  },

  async putNode(node) {
    await requestJson(`/api/db/nodes/${encodeURIComponent(node.id)}`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify(node),
    });
  },

  async putNodes(nodes) {
    await requestJson('/api/db/nodes', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ nodes }),
    });
  },

  async deleteNode(id) {
    await requestJson(`/api/db/nodes/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async getBlob(id) {
    const response = await request(`/api/db/blobs/${encodeURIComponent(id)}`);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error('That file could not be read from the server.');

    const blob = await response.blob();
    return { id, blob };
  },

  async putBlob(id, blob) {
    const response = await request(`/api/db/blobs/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': (blob && blob.type) || 'application/octet-stream' },
      body: blob,
    });

    if (!response.ok) {
      const data = await bodyOf(response);
      throw new Error((data && data.error) || 'That file could not be stored on the server.');
    }
    return true;
  },

  async deleteBlob(id) {
    await requestJson(`/api/db/blobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async getSetting(key) {
    const response = await request(`/api/db/settings/${encodeURIComponent(key)}`);
    if (response.status === 404) return undefined;
    if (!response.ok) return undefined;
    const data = await bodyOf(response);
    if (!data || !('value' in data)) return undefined;
    return { key, value: data.value };
  },

  async putSetting(key, value) {
    await requestJson(`/api/db/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ value }),
    });
  },

  async deleteSetting(key) {
    await requestJson(`/api/db/settings/${encodeURIComponent(key)}`, { method: 'DELETE' });
  },

  async clearAll() {
    await requestJson('/api/db/clear', { method: 'POST' });
  },
};

/* ------------------------------------------------------------------ */
/* Share links                                                         */
/* ------------------------------------------------------------------ */

export async function shareFile(id) {
  return requestJson(`/api/files/${encodeURIComponent(id)}/share`, { method: 'POST' });
}

export async function stopSharing(id) {
  await requestJson(`/api/files/${encodeURIComponent(id)}/share`, { method: 'DELETE' });
}

// Every link this account has handed out, so the drive can show them, copy one
// again, or stop one.
export async function listShares() {
  const data = await requestJson('/api/files/shares');
  return Array.isArray(data.shares) ? data.shares : [];
}

// How large a single file the server will take, or 0 when it did not say.
export function uploadLimit() {
  const info = state.server;
  const value = info && info.limits && Number(info.limits.uploadBytes);
  return value > 0 ? value : 0;
}

// A link the drive itself can hand to anything, with no sign-in needed.
export async function directLink(node) {
  const share = await shareFile(node.id);
  return share.url;
}

/* ------------------------------------------------------------------ */
/* Deluxe Docs                                                         */
/* ------------------------------------------------------------------ */

export function docsSettings() {
  try {
    const raw = localStorage.getItem(DOCS_KEY);
    if (!raw) return { ...DOCS_DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      url: typeof parsed.url === 'string' ? parsed.url : '',
      clientId: typeof parsed.clientId === 'string' ? parsed.clientId : '',
      autoOpen: parsed.autoOpen !== false,
    };
  } catch (error) {
    return { ...DOCS_DEFAULTS };
  }
}

export function saveDocsSettings(next) {
  const value = {
    url: typeof next.url === 'string' ? next.url : '',
    clientId: typeof next.clientId === 'string' ? next.clientId : '',
    autoOpen: next.autoOpen !== false,
  };
  try {
    localStorage.setItem(DOCS_KEY, JSON.stringify(value));
  } catch (error) {
    /* storage can be blocked; the connection still works this visit */
  }
  return value;
}

export function docsReady() {
  const settings = docsSettings();
  return !!settings.url && !!settings.clientId && isOnline();
}

// The viewer address, cleaned to the page itself: no query, no hash, no
// trailing slash. Deluxe Docs returns to exactly this address after sign-in.
// "deluxe-docs.example" is what people paste, so https is assumed for it.
export function normalizePage(value) {
  let raw = String(value || '').trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw.replace(/^\/+/, '')}`;

  let url;
  try {
    url = new URL(raw);
  } catch (error) {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) return null;
  if (!url.hostname) return null;

  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname}`;
}

export async function connectDocs(pageUrl) {
  if (!isOnline()) {
    throw new Error('Deluxe Docs needs the Deluxe Drive server. This copy is running without one.');
  }

  const normalized = normalizePage(pageUrl);
  if (!normalized) {
    throw new Error('Enter the Deluxe Docs page address, starting with https://');
  }

  const data = await requestJson('/api/oauth/clients', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: 'Deluxe Docs', redirectUri: normalized }),
  });

  return saveDocsSettings({
    ...docsSettings(),
    url: normalized,
    clientId: data.clientId,
    autoOpen: true,
  });
}

export async function disconnectDocs() {
  const settings = docsSettings();
  if (settings.clientId && isOnline()) {
    try {
      await requestJson(`/api/oauth/clients/${encodeURIComponent(settings.clientId)}`, { method: 'DELETE' });
    } catch (error) {
      /* already gone on the server; drop it here anyway */
    }
  }
  return saveDocsSettings({ ...DOCS_DEFAULTS, autoOpen: settings.autoOpen });
}

// What Deluxe Docs needs to sign in against this drive, for a viewer that
// asks for it.
export function docsConfig(settings = docsSettings()) {
  const origin = location.origin;
  return {
    driveName: 'Deluxe Drive',
    driveUrl: origin,
    authorizeUrl: `${origin}/oauth/authorize`,
    tokenUrl: `${origin}/oauth/token`,
    userInfoUrl: `${origin}/oauth/userinfo`,
    clientId: settings.clientId || '',
    scope: 'openid profile drive.read',
  };
}

function viewerUrl(fileUrl, name) {
  const settings = docsSettings();
  let target;
  try {
    target = new URL(settings.url);
  } catch (error) {
    return null;
  }

  // Deluxe Docs reads the file's direct link from `url` (its own README says
  // `?url=`); `name` only sets the tab's title.
  target.searchParams.set('url', fileUrl);
  if (name) target.searchParams.set('name', name);
  return target.toString();
}

// Opens a file in Deluxe Docs. The file is shared first, so the viewer needs
// no sign-in of its own to read it. The tab is opened before the share is
// asked for, so the browser still counts it as part of the click.
export async function openInDocs(node) {
  const settings = docsSettings();
  if (!settings.url) throw new Error('Connect Deluxe Docs first.');
  if (!isOnline()) throw new Error('Deluxe Docs needs the Deluxe Drive server.');

  const tab = window.open('about:blank', '_blank');

  try {
    const share = await shareFile(node.id);
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

/* ------------------------------------------------------------------ */
/* Local fallback                                                      */
/* ------------------------------------------------------------------ */

// Used by the connection dialog to explain where files are kept.
export function storageLabel() {
  return isOnline() ? 'Deluxe Drive server' : 'this browser';
}

export { localDb };
