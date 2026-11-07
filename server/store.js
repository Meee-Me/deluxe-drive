'use strict';

// Storage for the Deluxe Drive server.
//
// Everything the drive keeps is a plain file under DATA_DIR, so a restart
// keeps the accounts, the files and the public share links:
//
//   global/accounts.json      accounts: name, salt, PBKDF2 hash
//   global/shares.json        public share links, by token
//   accounts/<id>/nodes.json  the file/folder tree of one account
//   accounts/<id>/blobs/<id>  the file itself
//   accounts/<id>/blobs.json  the mime type of each stored file
//   accounts/<id>/settings.json
//   oauth/clients.json        the viewers (Deluxe Docs) allowed to sign in
//
// Sessions and the short-lived OAuth codes are kept in memory: they cost
// nothing to recreate, and they should not be lying around on disk.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(os.tmpdir(), 'deluxe-drive-data'));

const GLOBAL_DIR = path.join(DATA_DIR, 'global');
const ACCOUNTS_DIR = path.join(DATA_DIR, 'accounts');
const OAUTH_DIR = path.join(DATA_DIR, 'oauth');

const ACCOUNTS_FILE = path.join(GLOBAL_DIR, 'accounts.json');
const SHARES_FILE = path.join(GLOBAL_DIR, 'shares.json');
const CLIENTS_FILE = path.join(OAUTH_DIR, 'clients.json');
const LINKS_FILE = path.join(OAUTH_DIR, 'links.json');

const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;
const HEX_PATTERN = /^[0-9a-fA-F]{16,128}$/;

const PBKDF2_ITERATIONS = 120000;
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const CODE_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;

let readyPromise = null;

function init() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await fsp.mkdir(GLOBAL_DIR, { recursive: true });
      await fsp.mkdir(ACCOUNTS_DIR, { recursive: true });
      await fsp.mkdir(OAUTH_DIR, { recursive: true });
    })();
    readyPromise.catch(() => {
      readyPromise = null;
    });
  }
  return readyPromise;
}

/* ---------------- small helpers ---------------- */

// One writer at a time: every read-modify-write of a JSON file goes through
// this queue, so two uploads finishing together cannot lose one another.
let writeChain = Promise.resolve();

function serial(task) {
  const run = writeChain.then(task, task);
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function readJson(file, fallback) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    if (!text.trim()) return fallback;
    const parsed = JSON.parse(text);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    console.error('Could not read', file, error && error.message);
    return fallback;
  }
}

async function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(temporary, JSON.stringify(value, null, 2));
  await fsp.rename(temporary, file);
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function requestError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

/* ---------------- passwords ---------------- */

// The browser hashes the password itself (PBKDF2-SHA256, 120 000 rounds,
// a random 16-byte salt) and only sends the hash. The server has to be able
// to check that same hash for the sign-in page Deluxe Docs is sent to, so it
// derives it exactly the same way.
function hashPassword(password, saltHex) {
  const salt = Buffer.from(String(saltHex || ''), 'hex');
  if (!salt.length) throw requestError('The account record has no salt.', 500);
  return crypto.pbkdf2Sync(String(password), salt, PBKDF2_ITERATIONS, 32, 'sha256').toString('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ---------------- accounts ---------------- */

let accountsCache = null;

async function loadAccounts() {
  if (!accountsCache) {
    const data = await readJson(ACCOUNTS_FILE, { accounts: [] });
    accountsCache = Array.isArray(data.accounts) ? data.accounts : [];
  }
  return accountsCache;
}

async function saveAccounts() {
  await writeJson(ACCOUNTS_FILE, { accounts: accountsCache || [] });
}

function publicAccount(account) {
  return { id: account.id, name: account.name, salt: account.salt };
}

async function accountById(id) {
  if (!ID_PATTERN.test(String(id || ''))) return null;
  const accounts = await loadAccounts();
  return accounts.find((account) => account.id === id) || null;
}

async function accountByName(name) {
  const clean = String(name || '')
    .trim()
    .toLowerCase();
  if (!clean) return null;
  const accounts = await loadAccounts();
  return accounts.find((account) => String(account.name).toLowerCase() === clean) || null;
}

async function createAccount({ name, salt, hash }) {
  const cleanName = String(name || '').trim().slice(0, 24);
  const cleanSalt = String(salt || '');
  const cleanHash = String(hash || '');

  if (!cleanName) throw requestError('Type a name for the account.', 400);
  if (!HEX_PATTERN.test(cleanSalt) || !HEX_PATTERN.test(cleanHash)) {
    throw requestError('That account record is not valid.', 400);
  }

  await init();

  return serial(async () => {
    const accounts = await loadAccounts();
    if (accounts.some((account) => account.name.toLowerCase() === cleanName.toLowerCase())) {
      const error = requestError('That name is already used on this drive.', 409);
      error.code = 'name-taken';
      throw error;
    }

    const now = Date.now();
    const account = {
      id: `u_${now.toString(36)}_${randomToken(3)}`,
      name: cleanName,
      salt: cleanSalt,
      hash: cleanHash,
      createdAt: now,
      updatedAt: now,
    };

    accounts.push(account);
    await saveAccounts();
    return account;
  });
}

// A name nobody owns still gets a plausible looking record, so that asking
// for it cannot be used to find out who has an account here: the sign-in
// that follows simply fails.
function fakeAccount(name) {
  const secret = process.env.DELUXE_FAKE_SECRET || 'deluxe-drive-unknown-account';
  const clean = String(name || '')
    .trim()
    .slice(0, 24);
  const digest = crypto.createHmac('sha256', secret).update(clean.toLowerCase()).digest('hex');
  return { id: `u_unknown_${digest.slice(0, 16)}`, name: clean, salt: digest.slice(0, 32) };
}

async function renameAccount(id, name) {
  const clean = String(name || '').trim().slice(0, 24);
  if (!clean) throw requestError('Type a name for the account.', 400);

  return serial(async () => {
    const accounts = await loadAccounts();
    const account = accounts.find((entry) => entry.id === id);
    if (!account) throw requestError('That account is not here.', 404);
    if (accounts.some((entry) => entry.id !== id && entry.name.toLowerCase() === clean.toLowerCase())) {
      throw requestError('That name is already used on this drive.', 409);
    }
    account.name = clean;
    account.updatedAt = Date.now();
    await saveAccounts();
    return account;
  });
}

async function setAccountPassword(id, salt, hash) {
  const cleanSalt = String(salt || '');
  const cleanHash = String(hash || '');
  if (!HEX_PATTERN.test(cleanSalt) || !HEX_PATTERN.test(cleanHash)) {
    throw requestError('That account record is not valid.', 400);
  }

  return serial(async () => {
    const accounts = await loadAccounts();
    const account = accounts.find((entry) => entry.id === id);
    if (!account) throw requestError('That account is not found.', 404);
    account.salt = cleanSalt;
    account.hash = cleanHash;
    account.updatedAt = Date.now();
    await saveAccounts();
    return account;
  });
}

async function deleteAccount(id) {
  await init();

  return serial(async () => {
    const accounts = await loadAccounts();
    const index = accounts.findIndex((entry) => entry.id === id);
    if (index < 0) return false;

    accounts.splice(index, 1);
    await saveAccounts();

    const dir = accountDir(id);
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
    accountCache.delete(id);

    const shares = await loadShares();
    let changed = false;
    for (const [token, share] of Object.entries(shares)) {
      if (share.accountId === id) {
        delete shares[token];
        changed = true;
      }
    }
    if (changed) await saveShares();

    for (const [token, session] of sessions) {
      if (session.userId === id) sessions.delete(token);
    }

    return true;
  });
}

/* ---------------- per-account state ---------------- */

const accountCache = new Map();

function accountDir(accountId) {
  if (!ID_PATTERN.test(String(accountId || ''))) return null;
  return path.join(ACCOUNTS_DIR, String(accountId));
}

function blobPath(accountId, blobId) {
  if (!ID_PATTERN.test(String(blobId || ''))) return null;
  const dir = accountDir(accountId);
  return dir ? path.join(dir, 'blobs', String(blobId)) : null;
}

async function accountState(accountId) {
  const dir = accountDir(accountId);
  if (!dir) throw requestError('That account is not valid.', 400);

  if (!accountCache.has(accountId)) {
    const [nodesData, settingsData, mimesData] = await Promise.all([
      readJson(path.join(dir, 'nodes.json'), { nodes: {} }),
      readJson(path.join(dir, 'settings.json'), { settings: {} }),
      readJson(path.join(dir, 'blobs.json'), { mimes: {} }),
    ]);

    accountCache.set(accountId, {
      dir,
      nodes: plainObject(nodesData.nodes),
      settings: plainObject(settingsData.settings),
      mimes: plainObject(mimesData.mimes),
    });
  }

  return accountCache.get(accountId);
}

async function saveNodesNow(accountId) {
  const state = await accountState(accountId);
  await writeJson(path.join(state.dir, 'nodes.json'), { nodes: state.nodes });
}

async function saveSettingsNow(accountId) {
  const state = await accountState(accountId);
  await writeJson(path.join(state.dir, 'settings.json'), { settings: state.settings });
}

async function saveMimesNow(accountId) {
  const state = await accountState(accountId);
  await writeJson(path.join(state.dir, 'blobs.json'), { mimes: state.mimes });
}

/* ---------------- nodes ---------------- */

async function listNodes(accountId) {
  await init();
  const state = await accountState(accountId);
  return Object.values(state.nodes);
}

async function getNode(accountId, nodeId) {
  if (!ID_PATTERN.test(String(nodeId || ''))) return null;
  const state = await accountState(accountId);
  return state.nodes[nodeId] || null;
}

async function putNode(accountId, node) {
  await init();
  if (!node || typeof node !== 'object') throw requestError('That file record is not valid.', 400);
  if (!ID_PATTERN.test(String(node.id || ''))) throw requestError('That file id is not valid.', 400);

  return serial(async () => {
    const state = await accountState(accountId);
    state.nodes[node.id] = node;
    await saveNodesNow(accountId);
    return node;
  });
}

async function putNodes(accountId, nodes) {
  await init();
  if (!Array.isArray(nodes)) throw requestError('That list of files is not valid.', 400);
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || !ID_PATTERN.test(String(node.id || ''))) {
      throw requestError('One of those file records is not valid.', 400);
    }
  }

  return serial(async () => {
    const state = await accountState(accountId);
    for (const node of nodes) state.nodes[node.id] = node;
    await saveNodesNow(accountId);
    return nodes.length;
  });
}

async function deleteNode(accountId, nodeId) {
  if (!ID_PATTERN.test(String(nodeId || ''))) return false;

  return serial(async () => {
    const state = await accountState(accountId);
    if (!(nodeId in state.nodes)) return false;
    delete state.nodes[nodeId];
    await saveNodesNow(accountId);
    return true;
  });
}

/* ---------------- settings ---------------- */

async function getSetting(accountId, key) {
  const state = await accountState(accountId);
  if (!Object.prototype.hasOwnProperty.call(state.settings, key)) return undefined;
  return state.settings[key];
}

async function putSetting(accountId, key, value) {
  await init();
  return serial(async () => {
    const state = await accountState(accountId);
    state.settings[key] = value;
    await saveSettingsNow(accountId);
    return value;
  });
}

async function deleteSetting(accountId, key) {
  return serial(async () => {
    const state = await accountState(accountId);
    if (!(key in state.settings)) return false;
    delete state.settings[key];
    await saveSettingsNow(accountId);
    return true;
  });
}

/* ---------------- blobs ---------------- */

async function blobInfo(accountId, blobId) {
  await init();
  const file = blobPath(accountId, blobId);
  if (!file) return null;

  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (error) {
    return null;
  }
  if (!stat.isFile()) return null;

  const state = accountCache.has(accountId)
    ? accountCache.get(accountId)
    : await accountState(accountId);

  return {
    path: file,
    size: stat.size,
    updatedAt: stat.mtimeMs,
    mime: state.mimes[blobId] || 'application/octet-stream',
  };
}

async function saveBlob(accountId, blobId, source, mime) {
  await init();
  const file = blobPath(accountId, blobId);
  if (!file) throw requestError('That file id is not valid.', 400);

  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.upload`;

  try {
    await pipeline(source, fs.createWriteStream(temporary));
    await fsp.rename(temporary, file);
  } catch (error) {
    await fsp.rm(temporary, { force: true });
    throw error;
  }

  let size = 0;
  try {
    const stat = await fsp.stat(file);
    size = stat.size;
  } catch (error) {
    size = 0;
  }

  return serial(async () => {
    const state = await accountState(accountId);
    state.mimes[blobId] = String(mime || 'application/octet-stream').slice(0, 120);
    await saveMimesNow(accountId);
    return size;
  });
}

async function deleteBlob(accountId, blobId) {
  const file = blobPath(accountId, blobId);
  if (!file) return false;

  await fsp.rm(file, { force: true });

  return serial(async () => {
    const state = await accountState(accountId);
    if (!(blobId in state.mimes)) return true;
    delete state.mimes[blobId];
    await saveMimesNow(accountId);
    return true;
  });
}

async function clearAccountData(accountId) {
  return serial(async () => {
    const state = await accountState(accountId);
    state.nodes = {};
    state.mimes = {};
    state.settings = {};

    await fsp.rm(path.join(state.dir, 'blobs'), { recursive: true, force: true });
    await saveNodesNow(accountId);
    await saveMimesNow(accountId);
    await saveSettingsNow(accountId);

    const shares = await loadShares();
    let changed = false;
    for (const [token, share] of Object.entries(shares)) {
      if (share.accountId === accountId) {
        delete shares[token];
        changed = true;
      }
    }
    if (changed) await saveShares();

    return true;
  });
}

/* ---------------- share links ---------------- */

let sharesCache = null;

async function loadShares() {
  if (!sharesCache) {
    const data = await readJson(SHARES_FILE, { shares: {} });
    sharesCache = plainObject(data.shares);
  }
  return sharesCache;
}

async function saveShares() {
  await writeJson(SHARES_FILE, { shares: sharesCache || {} });
}

async function ensureShare(accountId, blobId, name) {
  await init();

  return serial(async () => {
    const shares = await loadShares();

    for (const [token, share] of Object.entries(shares)) {
      if (share.accountId === accountId && share.blobId === blobId) {
        return { token, share };
      }
    }

    const token = randomToken(16);
    const share = {
      token,
      accountId,
      blobId,
      name: String(name || '').slice(0, 200),
      createdAt: Date.now(),
    };
    shares[token] = share;
    await saveShares();
    return { token, share };
  });
}

async function shareByToken(token) {
  if (!/^[0-9a-f]{8,64}$/i.test(String(token || ''))) return null;
  const shares = await loadShares();
  return shares[token] || null;
}

async function revokeShare(accountId, blobId) {
  return serial(async () => {
    const shares = await loadShares();
    let changed = false;
    for (const [token, share] of Object.entries(shares)) {
      if (share.accountId === accountId && share.blobId === blobId) {
        delete shares[token];
        changed = true;
      }
    }
    if (changed) await saveShares();
    return changed;
  });
}

// Every link this account has handed out, newest first, for the drive's
// "Shared links" list.
async function listShares(accountId) {
  await init();
  const shares = await loadShares();
  return Object.values(shares)
    .filter((share) => share.accountId === accountId)
    .map((share) => ({ ...share }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/* ---------------- Documentation links (Deluxe Docs setup) ---------------- */

// One stable connection link per account. Deluxe Docs pastes the link, fetches
// it, and gets the endpoints plus a client registered for its own page, so any
// copy of the viewer can connect with the same link id. The link holds no
// secret, and it is kept on disk so it survives restarts.
let linksCache = null;

async function loadLinks() {
  if (!linksCache) {
    const data = await readJson(LINKS_FILE, { links: {} });
    linksCache = plainObject(data.links);
  }
  return linksCache;
}

async function saveLinks() {
  await writeJson(LINKS_FILE, { links: linksCache || {} });
}

async function ensureDocsLink(accountId) {
  await init();

  return serial(async () => {
    const links = await loadLinks();
    const id = String(accountId || '');

    for (const [code, link] of Object.entries(links)) {
      if (link.accountId === id) return { code, link };
    }

    const code = randomToken(6);
    const link = { accountId: id, createdAt: Date.now() };
    links[code] = link;
    await saveLinks();
    return { code, link };
  });
}

async function docsLinkByCode(code) {
  const clean = String(code || '');
  if (!/^[0-9a-f]{8,64}$/i.test(clean)) return null;
  const links = await loadLinks();
  return links[clean] || null;
}

/* ---------------- sessions ---------------- */

const sessions = new Map(); // token -> { token, userId, clientId, scope, createdAt, expiresAt }

function createSession(userId, options = {}) {
  const ttlSeconds = Number(options.ttlSeconds) > 0 ? Number(options.ttlSeconds) : SESSION_TTL_SECONDS;
  const now = Date.now();

  if (sessions.size > 5000) {
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(token);
    }
  }

  const session = {
    token: randomToken(32),
    userId,
    clientId: options.clientId || null,
    scope: options.scope || 'drive',
    createdAt: now,
    expiresAt: now + ttlSeconds * 1000,
  };

  sessions.set(session.token, session);
  return { token: session.token, expiresIn: ttlSeconds };
}

function sessionFor(token) {
  const clean = String(token || '');
  if (!clean) return null;
  const session = sessions.get(clean);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(clean);
    return null;
  }
  return session;
}

function dropSession(token) {
  sessions.delete(String(token || ''));
}

/* ---------------- OAuth codes and consent steps ---------------- */

const codes = new Map(); // code -> entry
const pendingLogins = new Map(); // id -> entry

function issueCode(entry) {
  const now = Date.now();

  for (const [code, value] of codes) {
    if (value.expiresAt <= now) codes.delete(code);
  }
  for (const [id, value] of pendingLogins) {
    if (value.expiresAt <= now) pendingLogins.delete(id);
  }

  const code = randomToken(24);
  codes.set(code, { ...entry, createdAt: now, expiresAt: now + CODE_TTL_MS });
  return code;
}

function codeByValue(code) {
  const entry = codes.get(String(code || ''));
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    codes.delete(String(code));
    return null;
  }
  return entry;
}

function dropCode(code) {
  codes.delete(String(code || ''));
}

function createPendingLogin(entry) {
  const id = randomToken(16);
  pendingLogins.set(id, { ...entry, createdAt: Date.now(), expiresAt: Date.now() + PENDING_TTL_MS });
  return id;
}

function takePendingLogin(id) {
  const clean = String(id || '');
  const entry = pendingLogins.get(clean);
  if (!entry) return null;
  pendingLogins.delete(clean);
  if (entry.expiresAt <= Date.now()) return null;
  return entry;
}

/* ---------------- OAuth clients (viewers such as Deluxe Docs) ---------------- */

let clientsCache = null;

async function loadClients() {
  if (!clientsCache) {
    const data = await readJson(CLIENTS_FILE, { clients: [] });
    clientsCache = Array.isArray(data.clients) ? data.clients : [];
  }
  return clientsCache;
}

async function saveClients() {
  await writeJson(CLIENTS_FILE, { clients: clientsCache || [] });
}

async function listClients() {
  await init();
  return (await loadClients()).map((client) => ({ ...client }));
}

async function clientById(id) {
  const clean = String(id || '');
  if (!clean) return null;
  const clients = await loadClients();
  return clients.find((client) => client.id === clean) || null;
}

async function registerClient({ name, redirectUri }) {
  const cleanName = String(name || 'Deluxe Docs').trim().slice(0, 40) || 'Deluxe Docs';
  const cleanRedirect = String(redirectUri || '');

  await init();

  return serial(async () => {
    const clients = await loadClients();
    const existing = clients.find((client) => client.redirectUri === cleanRedirect);
    if (existing) {
      existing.name = cleanName;
      await saveClients();
      return { ...existing };
    }

    const client = {
      id: `dc_${randomToken(8)}`,
      name: cleanName,
      redirectUri: cleanRedirect,
      createdAt: Date.now(),
    };
    clients.push(client);
    await saveClients();
    return { ...client };
  });
}

async function removeClient(id) {
  return serial(async () => {
    const clients = await loadClients();
    const index = clients.findIndex((client) => client.id === id);
    if (index < 0) return false;
    clients.splice(index, 1);
    await saveClients();
    return true;
  });
}

module.exports = {
  dataDir: DATA_DIR,
  init,

  accountById,
  accountByName,
  createAccount,
  fakeAccount,
  renameAccount,
  setAccountPassword,
  deleteAccount,
  publicAccount,
  hashPassword,
  safeEqual,

  listNodes,
  getNode,
  putNode,
  putNodes,
  deleteNode,

  getSetting,
  putSetting,
  deleteSetting,

  blobInfo,
  saveBlob,
  deleteBlob,
  clearAccountData,

  ensureShare,
  listShares,
  shareByToken,
  revokeShare,

  createSession,
  sessionFor,
  dropSession,

  issueCode,
  codeByValue,
  dropCode,
  createPendingLogin,
  takePendingLogin,

  listClients,
  clientById,
  registerClient,
  removeClient,

  ensureDocsLink,
  docsLinkByCode,

  SESSION_TTL_SECONDS,
};
