import { db as localDb, openDB } from './db.js';
import * as auth from './auth.js';
import * as cloud from './cloud.js';
import { icon, escapeHtml, formatBytes, formatDate, formatDateTime, showDialog, toast } from './ui.js';
import { officeType, renderOfficePreview, renderDelimited, renderDocxFaithful } from './office.js';
import { mountPdf, mountScaled, closeViewer } from './viewer.js';

// Bumped by hand with each deploy. It is printed on the lock screen so the
// running build can be read out loud, which separates "stale cached page"
// from "real bug" without guessing.
const BUILD = 'build 26';

// The drive keeps its files in this browser's IndexedDB, or - when the page is
// served by the Deluxe Drive server - on that server, under the signed-in
// account's token, so the same drive opens on every device. Both answer these
// calls the same way, so the rest of the app never has to ask which one it is.
function activeStore() {
  return cloud.isOnline() ? cloud.remote : localDb;
}

const db = {
  allNodes: () => activeStore().allNodes(),
  getNode: (id) => activeStore().getNode(id),
  putNode: (node) => activeStore().putNode(node),
  putNodes: (nodes) => activeStore().putNodes(nodes),
  deleteNode: (id) => activeStore().deleteNode(id),

  getBlob: (id) => activeStore().getBlob(id),
  putBlob: (id, blob) => activeStore().putBlob(id, blob),
  deleteBlob: (id) => activeStore().deleteBlob(id),

  getSetting: (key) => activeStore().getSetting(key),
  putSetting: (key, value) => activeStore().putSetting(key, value),
  deleteSetting: (key) => activeStore().deleteSetting(key),

  clearAll: () => activeStore().clearAll(),
};

// Tells the lock-screen fallback in index.html that the app really started.
window.__deluxeDriveStarted = true;
window.__deluxeDriveBuild = BUILD;

const bootFallback = document.getElementById('boot-fallback');
const bootFallbackText = document.getElementById('boot-fallback-text');
const bootFallbackDetail = document.getElementById('boot-fallback-detail');
if (bootFallback) bootFallback.classList.add('hidden');

/* ------------------------------------------------------------------ */
/* Crash reporting: never fail silently                               */
/* ------------------------------------------------------------------ */

function describeError(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  const name = error.name || 'Error';
  const message = error.message || String(error);
  return `${name}: ${message}`;
}

function showBootFailure(stage, error) {
  const lines = [BUILD];
  if (stage) lines.push(`Failed while ${stage}`);
  lines.push(describeError(error));
  if (error && typeof error === 'object' && error.stack) lines.push('', String(error.stack));

  const text = lines.join('\n');
  window.__deluxeDriveLastError = text;
  console.error('Deluxe Drive could not start:', stage, error);

  if (bootFallback) {
    if (bootFallbackText) bootFallbackText.textContent = 'Deluxe Drive could not start on this device.';
    if (bootFallbackDetail) bootFallbackDetail.textContent = text;
    bootFallback.classList.remove('hidden');
    return;
  }

  document.body.innerHTML = `<div class="boot-error"><h1>Deluxe Drive</h1><p>${escapeHtml(text)}</p></div>`;
}

function reportCrash(message) {
  console.error('Deluxe Drive error:', message);

  const app = document.getElementById('app');
  const unlocked = app && !app.classList.contains('hidden');

  if (unlocked) {
    toast(`Something went wrong: ${message}`);
    return;
  }

  showBootFailure('', message);
}

// Only errors raised by this app's own files are worth showing to the user.
// Browser extensions (crypto wallets inject `window.ethereum`, for example)
// throw constantly on every page, and catching those made the app look broken.
const OUR_SCRIPTS = ['/js/app.js', '/js/db.js', '/js/auth.js', '/js/ui.js', '/js/cloud.js'];

function fromThisApp(text) {
  const value = String(text || '');
  return OUR_SCRIPTS.some((path) => value.includes(path));
}

function fromAnotherProgram(text) {
  const value = String(text || '');
  return (
    value.includes('ethereum') ||
    value.includes('chrome-extension:') ||
    value.includes('safari-web-extension:') ||
    value.includes('moz-extension:') ||
    value.includes('extension://') ||
    value.includes('injectedScript')
  );
}

// A real script error targets the window; a resource error (e.g. a missing
// image) targets the element, and is not something to alarm the user about.
window.addEventListener('error', (event) => {
  if (!event || (event.target && event.target !== window)) return;

  const filename = String(event.filename || '');
  const message = String(event.message || '');
  const combined = `${filename} ${message}`;

  if (fromAnotherProgram(combined)) return;
  if (!fromThisApp(filename)) return;
  if (!message || message === 'Script error.') return;

  reportCrash(message);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event && event.reason;
  const text = reason && reason.stack ? String(reason.stack) : String(reason || '');

  if (fromAnotherProgram(text)) return;
  if (!fromThisApp(text)) return;

  reportCrash(describeError(reason));
});

const $ = (selector) => document.querySelector(selector);

const state = {
  currentUser: null,
  nodes: new Map(),
  view: 'drive', // drive | recent | starred | trash | search
  folderId: null,
  query: '',
  layout: localStorage.getItem('dd.layout') === 'list' ? 'list' : 'grid',
  sort: ['name', 'modified', 'size'].includes(localStorage.getItem('dd.sort'))
    ? localStorage.getItem('dd.sort')
    : 'name',
  prevView: 'drive',
  suppressClick: 0,
  previewId: null,
  previewIds: [],
  previewIndex: -1,
  selectMode: false,
  selected: new Set(),
  shared: new Set(), // node ids with a share link (server drives only)
};

const objUrls = new Map(); // nodeId -> object URL (thumbnails and previews)
let uiBound = false;
let dragDepth = 0;
let pressTimer = null;

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

let theme = localStorage.getItem('dd.theme');
if (theme !== 'dark' && theme !== 'light') {
  theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
document.documentElement.setAttribute('data-theme', theme);

// Keep the browser chrome (the bar above the page) in step with the theme.
function updateThemeColor(currentTheme) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', currentTheme === 'dark' ? '#131314' : '#4f46e5');
}
updateThemeColor(theme);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function uid() {
  return `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  heic: 'image/heic',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  zip: 'application/zip',
};

function mimeFromName(name = '') {
  const ext = String(name).toLowerCase().split('.').pop();
  return MIME_BY_EXT[ext] || '';
}

function fileKind(mime = '', name = '') {
  const type = String(mime).toLowerCase();
  const ext = String(name).toLowerCase().split('.').pop();

  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (type.includes('spreadsheet') || ['xls', 'xlsx', 'csv', 'tsv', 'ods'].includes(ext)) return 'sheet';
  if (type.includes('presentation') || ['ppt', 'pptx', 'odp', 'key'].includes(ext)) return 'slides';
  if (type.includes('word') || ['doc', 'docx', 'odt', 'rtf', 'pages'].includes(ext)) return 'doc';
  if (
    type.includes('zip') ||
    type.includes('compressed') ||
    ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'dmg', 'iso'].includes(ext)
  ) {
    return 'zip';
  }
  if (type.startsWith('text/') || ['json', 'xml', 'yml', 'yaml', 'md', 'html', 'htm'].includes(ext)) return 'text';
  if (
    [
      'js',
      'jsx',
      'ts',
      'tsx',
      'css',
      'scss',
      'py',
      'rb',
      'go',
      'rs',
      'java',
      'c',
      'h',
      'cpp',
      'cs',
      'php',
      'sh',
      'bash',
      'swift',
      'kt',
      'sql',
      'toml',
      'ini',
      'log',
    ].includes(ext)
  ) {
    return 'code';
  }
  return 'file';
}

function iconForKind(kind) {
  if (kind === 'folder') return 'folder';
  return ['image', 'video', 'audio', 'pdf', 'sheet', 'slides', 'doc', 'zip', 'text', 'code'].includes(kind)
    ? kind
    : 'file';
}

function isTextual(kind, mime, name) {
  if (kind === 'text' || kind === 'code') return true;
  const type = String(mime || '');
  if (type.startsWith('application/json') || type.startsWith('application/xml')) return true;
  const ext = String(name || '').toLowerCase().split('.').pop();
  return ['txt', 'md', 'csv', 'tsv', 'json', 'xml', 'yml', 'yaml', 'log', 'ini', 'toml', 'srt', 'vtt'].includes(ext);
}

function descendantIds(id) {
  const out = new Set();
  const stack = [id];
  while (stack.length) {
    const current = stack.pop();
    for (const node of state.nodes.values()) {
      if (node.parentId === current && !out.has(node.id)) {
        out.add(node.id);
        if (node.type === 'folder') stack.push(node.id);
      }
    }
  }
  return out;
}

function uniqueName(name, parentId, excludeId = null) {
  const base = String(name || '').trim() || 'Untitled';
  const taken = new Set(
    [...state.nodes.values()]
      .filter((node) => node.parentId === parentId && node.id !== excludeId && !node.trashed)
      .map((node) => node.name.toLowerCase())
  );
  if (!taken.has(base.toLowerCase())) return base;

  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  let index = 1;
  let candidate = `${stem} (${index})${ext}`;
  while (taken.has(candidate.toLowerCase())) {
    index += 1;
    candidate = `${stem} (${index})${ext}`;
  }
  return candidate;
}

/* ------------------------------------------------------------------ */
/* Data loading and listing                                            */
/* ------------------------------------------------------------------ */

async function loadNodes() {
  const all = await db.allNodes();
  const ownerId = state.currentUser ? state.currentUser.id : null;
  state.nodes = new Map(
    all.filter((node) => node.ownerId === ownerId).map((node) => [node.id, node])
  );
}

// Which files have a share link, so a card can show it and its menu can stop
// it. A drive without a server has no links to show.
async function refreshShares() {
  if (!cloud.isOnline()) {
    state.shared = new Set();
    return;
  }

  try {
    const shares = await cloud.listShares();
    state.shared = new Set(shares.map((share) => share.fileId).filter(Boolean));
  } catch (error) {
    state.shared = new Set();
  }
}

function currentItems() {
  const all = [...state.nodes.values()];

  if (state.view === 'search' && state.query) {
    const query = state.query.toLowerCase();
    return all.filter((node) => !node.trashed && node.name.toLowerCase().includes(query));
  }
  if (state.view === 'trash') {
    return all.filter((node) => node.trashed);
  }
  if (state.view === 'starred') {
    return all.filter((node) => !node.trashed && node.starred);
  }
  if (state.view === 'recent') {
    return all.filter((node) => !node.trashed && node.type === 'file').sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 60);
  }
  return all.filter((node) => !node.trashed && node.parentId === state.folderId);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sortItems(items) {
  const sorted = [...items];
  sorted.sort((a, b) => {
    const aFolder = a.type === 'folder';
    const bFolder = b.type === 'folder';
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    if (state.sort === 'modified') return (b.updatedAt || 0) - (a.updatedAt || 0);
    if (state.sort === 'size') return (b.size || 0) - (a.size || 0);
    return collator.compare(a.name, b.name);
  });
  return sorted;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function cardHtml(node, counts) {
  const isFolder = node.type === 'folder';
  const kind = isFolder ? 'folder' : fileKind(node.mime, node.name);
  const star = node.starred ? `<span class="star-badge">${icon('star')}</span>` : '';
  const shared = state.shared.has(node.id)
    ? `<span class="share-badge" title="Shared with a link">${icon('link')}</span>`
    : '';
  const selected = state.selectMode && state.selected.has(node.id);
  const badge = selected ? `<span class="select-badge">${icon('check')}</span>` : '';

  let meta;
  if (state.view === 'trash') {
    meta = `Deleted ${formatDate(node.trashedAt)}`;
  } else if (isFolder) {
    const count = counts && counts.has(node.id) ? counts.get(node.id) : 0;
    meta = `${count} item${count === 1 ? '' : 's'}`;
  } else {
    meta = `${formatBytes(node.size)} · ${formatDate(node.updatedAt)}`;
  }

  const menuButton = state.selectMode
    ? ''
    : `<button class="card-menu" type="button" data-menu="${node.id}" aria-label="More actions for ${escapeHtml(node.name)}">${icon('more')}</button>`;

  return `
    <div class="card${selected ? ' selected' : ''}" data-id="${node.id}" tabindex="0" role="button" aria-pressed="${selected ? 'true' : 'false'}" aria-label="${escapeHtml(node.name)}">
      <div class="card-thumb ${kind}" data-thumb="${node.id}">${icon(iconForKind(kind))}</div>
      <div class="card-body">
        <p class="card-name" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</p>
        <p class="card-meta">${shared}${escapeHtml(meta)}</p>
      </div>
      ${star}
      ${badge}
      ${menuButton}
    </div>`;
}

function renderNav() {
  const activeView = state.view === 'search' ? 'drive' : state.view;
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === activeView);
  });
  $('#empty-trash').classList.toggle('hidden', state.view !== 'trash');
}

function renderCrumbs() {
  const element = $('#crumbs');

  if (state.view !== 'drive') {
    const titles = { recent: 'Recent', starred: 'Starred', trash: 'Trash', search: 'Search results' };
    const subtitle =
      state.view === 'search' ? ` for “${escapeHtml(state.query)}”` : '';
    element.innerHTML = `<h2 class="crumb-title">${escapeHtml(titles[state.view] || 'Files')}${subtitle}</h2>`;
    return;
  }

  const chain = [];
  let cursor = state.folderId;
  let guard = 0;
  while (cursor && state.nodes.get(cursor) && guard < 64) {
    const node = state.nodes.get(cursor);
    chain.unshift(node);
    cursor = node.parentId;
    guard += 1;
  }

  const parts = [`<button class="crumb" type="button" data-crumb="root">My Drive</button>`];
  for (const node of chain) {
    parts.push(`<span class="crumb-sep">/</span>`);
    parts.push(`<button class="crumb" type="button" data-crumb="${node.id}">${escapeHtml(node.name)}</button>`);
  }
  element.innerHTML = parts.join('');
}

function renderEmpty(items) {
  const element = $('#empty');
  element.classList.toggle('hidden', items.length > 0);
  if (items.length > 0) return;

  const titles = {
    drive: state.folderId ? 'This folder is empty' : 'No files yet',
    recent: 'Nothing recent',
    starred: 'No starred items',
    trash: 'Trash is empty',
    search: 'No matches',
  };
  const texts = {
    drive: 'Upload files or create a folder to get started.',
    recent: 'Files you upload will show up here.',
    starred: 'Star files and folders to find them fast.',
    trash: 'Items you remove are kept here until you empty the trash.',
    search: 'Try a different name.',
  };
  const icons = { trash: 'trash', starred: 'star', search: 'search', recent: 'restore' };

  $('#empty-title').textContent = titles[state.view] || 'Nothing here';
  $('#empty-text').textContent = texts[state.view] || '';
  $('#empty-icon').innerHTML = icon(icons[state.view] || 'folder');
  $('#empty-upload').classList.toggle('hidden', state.view === 'trash' || state.view === 'search');
}

async function renderStorage() {
  const used = [...state.nodes.values()]
    .filter((node) => node.type === 'file')
    .reduce((sum, node) => sum + (node.size || 0), 0);

  // On the server there is no browser quota to show: the figure is simply
  // what this account is storing there.
  let quota = 0;
  if (!cloud.isOnline() && navigator.storage && navigator.storage.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      quota = estimate.quota || 0;
    } catch (_) {
      quota = 0;
    }
  }

  const fill = $('#storage-fill');
  const text = $('#storage-text');
  const percent = quota ? Math.min(100, (used / quota) * 100) : 0;
  if (fill) fill.style.width = `${Math.max(2, percent)}%`;
  if (text) text.textContent = quota ? `${formatBytes(used)} of ${formatBytes(quota)} used` : `${formatBytes(used)} used`;
}

async function hydrateThumbs(items) {
  for (const node of items) {
    if (node.type !== 'file') continue;
    if (fileKind(node.mime, node.name) !== 'image') continue;

    const holder = document.querySelector(`[data-thumb="${node.id}"]`);
    if (!holder || !holder.isConnected) continue;

    let url = objUrls.get(node.id);
    if (!url) {
      const record = await db.getBlob(node.id);
      if (!record || !record.blob) continue;
      url = URL.createObjectURL(record.blob);
      objUrls.set(node.id, url);
    }

    holder.innerHTML = '';
    holder.classList.add('has-image');
    holder.style.backgroundImage = `url("${url}")`;
  }
}

function render() {
  renderNav();
  renderCrumbs();

  const items = sortItems(currentItems());

  // One pass to know how many items each folder holds, for the card meta.
  const counts = new Map();
  for (const node of state.nodes.values()) {
    if (node.trashed || !node.parentId) continue;
    counts.set(node.parentId, (counts.get(node.parentId) || 0) + 1);
  }

  const grid = $('#file-grid');
  grid.className = state.layout === 'list' ? 'file-list' : 'file-grid';
  grid.innerHTML = items.map((node) => cardHtml(node, counts)).join('');

  renderEmpty(items);
  $('#view-toggle').innerHTML = icon(state.layout === 'grid' ? 'list' : 'grid');
  $('#sort-select').value = state.sort;

  updateSelectionBar();
  renderStorage();
  hydrateThumbs(items);
}

/* ------------------------------------------------------------------ */
/* Popup menu                                                          */
/* ------------------------------------------------------------------ */

function positionPopup(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;

  let left = rect.right - width;
  let top = rect.bottom + 6;

  if (left < 8) left = 8;
  if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

let popupHandler = null;

function closePopup() {
  const menu = $('#context-menu');
  if (!menu) return;
  if (popupHandler) {
    menu.removeEventListener('click', popupHandler);
    popupHandler = null;
  }
  menu.classList.add('hidden');
  menu.innerHTML = '';
}

function openPopup(anchor, items, onSelect) {
  const menu = $('#context-menu');
  if (popupHandler) menu.removeEventListener('click', popupHandler);
  menu.innerHTML = items
    .map(
      (item) => `
      <button class="menu-item${item.danger ? ' danger' : ''}" type="button" role="menuitem" data-action="${item.action}">
        ${icon(item.icon)}<span>${escapeHtml(item.label)}</span>
      </button>`
    )
    .join('');
  menu.classList.remove('hidden');
  positionPopup(menu, anchor);

  popupHandler = (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    closePopup();
    onSelect(button.dataset.action);
  };
  menu.addEventListener('click', popupHandler);
}

/* ------------------------------------------------------------------ */
/* File actions                                                        */
/* ------------------------------------------------------------------ */

function openNodeMenu(id, anchor) {
  const node = state.nodes.get(id);
  if (!node) return;

  const items = [];
  if (state.view === 'trash') {
    items.push({ action: 'restore', label: 'Restore', icon: 'restore' });
    items.push({ action: 'delete-forever', label: 'Delete forever', icon: 'trash', danger: true });
  } else {
    if (node.type === 'file') {
      items.push({ action: 'download', label: 'Download', icon: 'download' });
      if (cloud.isOnline()) {
        items.push({ action: 'share', label: 'Copy share link', icon: 'link' });
        if (state.shared.has(node.id)) {
          items.push({ action: 'unshare', label: 'Stop sharing', icon: 'close' });
        }
      }
      if (cloud.docsReady()) items.push({ action: 'docs', label: 'Open in Deluxe Docs', icon: 'doc' });
    }
    items.push({
      action: 'star',
      label: node.starred ? 'Remove from starred' : 'Add to starred',
      icon: node.starred ? 'star-off' : 'star',
    });
    items.push({ action: 'rename', label: 'Rename', icon: 'edit' });
    items.push({ action: 'info', label: 'Details', icon: 'info' });
    items.push({ action: 'move', label: 'Move to…', icon: 'folder' });
    items.push({ action: 'delete', label: 'Remove', icon: 'trash', danger: true });
  }

  openPopup(anchor, items, (action) => performNodeAction(action, id));
}

async function performNodeAction(action, id) {
  const node = state.nodes.get(id);
  if (!node) return;

  if (action === 'download') {
    downloadNode(node);
    return;
  }

  if (action === 'docs') {
    openInDocs(node);
    return;
  }

  if (action === 'share') {
    await shareNode(node);
    return;
  }

  if (action === 'unshare') {
    await unshareNode(node);
    return;
  }

  if (action === 'star') {
    node.starred = !node.starred;
    node.updatedAt = Date.now();
    await db.putNode(node);
    state.nodes.set(node.id, node);
    render();
    toast(node.starred ? 'Added to starred' : 'Removed from starred');
    return;
  }

  if (action === 'rename') {
    const name = await showDialog({ title: 'Rename', input: node.name, confirmLabel: 'Save' });
    if (!name || name === node.name) return;
    node.name = uniqueName(name, node.parentId, node.id);
    node.updatedAt = Date.now();
    await db.putNode(node);
    state.nodes.set(node.id, node);
    render();
    toast('Renamed');
    return;
  }

  if (action === 'info') {
    showDetailsDialog(node);
    return;
  }

  if (action === 'move') {
    const target = await pickFolder(node);
    if (target === undefined) return;
    if (target === node.parentId) {
      toast('It is already there');
      return;
    }
    node.parentId = target;
    node.name = uniqueName(node.name, target, node.id);
    node.updatedAt = Date.now();
    await db.putNode(node);
    state.nodes.set(node.id, node);
    render();
    toast('Moved');
    return;
  }

  if (action === 'delete') {
    node.trashed = true;
    node.trashedAt = Date.now();
    node.updatedAt = Date.now();
    await db.putNode(node);
    state.nodes.set(node.id, node);
    render();
    toast('Moved to trash');
    return;
  }

  if (action === 'restore') {
    if (node.parentId && !state.nodes.get(node.parentId)) node.parentId = null;
    node.trashed = false;
    node.trashedAt = null;
    node.updatedAt = Date.now();
    await db.putNode(node);
    state.nodes.set(node.id, node);
    render();
    toast('Restored');
    return;
  }

  if (action === 'delete-forever') {
    const sure = await showDialog({
      title: 'Delete forever?',
      message: `“${node.name}” will be gone permanently.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!sure) return;
    await deleteForever(node);
  }
}

async function removeForever(ids) {
  const all = new Set();
  for (const id of ids) {
    all.add(id);
    descendantIds(id).forEach((child) => all.add(child));
  }

  for (const id of all) {
    await db.deleteNode(id);
    await db.deleteBlob(id);
    const url = objUrls.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      objUrls.delete(id);
    }
    state.nodes.delete(id);
  }
}

async function deleteForever(node) {
  await removeForever([node.id]);
  render();
  toast('Deleted forever');
}

async function downloadNode(node) {
  const record = await db.getBlob(node.id);
  if (!record || !record.blob) {
    toast('This file has no stored data');
    return;
  }
  const url = URL.createObjectURL(record.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = node.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// A link anyone can open, with no sign-in: the server serves that one file.
async function shareNode(node) {
  try {
    const share = await cloud.shareFile(node.id);
    state.shared.add(node.id);
    render();
    await copyText(share.url);
    toast('Share link copied');
  } catch (error) {
    toast(error.message || 'That file could not be shared');
  }
}

async function unshareNode(node) {
  try {
    await cloud.stopSharing(node.id);
    state.shared.delete(node.id);
    render();
    toast('Share link stopped');
  } catch (error) {
    toast(error.message || 'That link could not be stopped');
  }
}

async function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      /* fall through to the old way */
    }
  }

  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  try {
    document.execCommand('copy');
  } catch (error) {
    /* nothing else to try */
  }
  field.remove();
  return true;
}

function pickFolder(node) {
  return new Promise((resolve) => {
    const root = $('#dialog');
    const blocked = node.type === 'folder' ? descendantIds(node.id) : new Set();
    const folders = [...state.nodes.values()]
      .filter((entry) => entry.type === 'folder' && !entry.trashed && entry.id !== node.id && !blocked.has(entry.id))
      .sort((a, b) => collator.compare(a.name, b.name));

    const rows = [
      `<button class="picker-item" type="button" data-target="root">${icon('drive')}<span>My Drive</span></button>`,
      ...folders.map(
        (folder) =>
          `<button class="picker-item" type="button" data-target="${folder.id}">${icon('folder')}<span>${escapeHtml(folder.name)}</span></button>`
      ),
    ];

    root.innerHTML = `
      <div class="dialog-backdrop" data-close="1"></div>
      <div class="dialog" role="dialog" aria-modal="true">
        <h2>Move “${escapeHtml(node.name)}”</h2>
        <div class="picker-list">${rows.join('')}</div>
        <div class="dialog-actions">
          <button class="btn ghost" type="button" data-action="cancel">Cancel</button>
        </div>
      </div>`;
    root.classList.remove('hidden');

    const close = (value) => {
      root.classList.add('hidden');
      root.innerHTML = '';
      resolve(value);
    };

    root.querySelector('[data-close]').addEventListener('click', () => close(undefined));
    root.querySelector('[data-action="cancel"]').addEventListener('click', () => close(undefined));
    root.querySelectorAll('.picker-item').forEach((button) => {
      button.addEventListener('click', () => {
        close(button.dataset.target === 'root' ? null : button.dataset.target);
      });
    });
  });
}

function openNode(id) {
  if (Date.now() < state.suppressClick) return;
  const node = state.nodes.get(id);
  if (!node) return;

  if (state.selectMode) {
    toggleSelected(id);
    return;
  }

  if (state.view === 'trash') {
    toast('Restore this item to open it');
    return;
  }

  if (node.type === 'folder') {
    exitSelectMode();
    state.view = 'drive';
    state.folderId = node.id;
    state.query = '';
    $('#search-input').value = '';
    render();
    return;
  }

  // A connected Deluxe Docs is the viewer for documents: opening one hands
  // the file over to it instead of drawing it here.
  if (cloud.docsReady() && cloud.docsSettings().autoOpen && isDocument(node) && node.size > 0) {
    openInDocs(node);
    return;
  }

  openPreview(node);
}

// The kinds Deluxe Docs is for: pages of text, documents, sheets, slides.
function isDocument(node) {
  return ['doc', 'sheet', 'slides', 'pdf', 'text', 'code'].includes(fileKind(node.mime, node.name));
}

// Hands the file to Deluxe Docs over a share link; if that fails the file
// still opens in the drive's own preview, so nothing is a dead end.
async function openInDocs(node) {
  try {
    await cloud.openInDocs(node);
    state.shared.add(node.id);
    render();
    toast(`Opening “${node.name}” in Deluxe Docs`);
  } catch (error) {
    toast(error.message || 'Deluxe Docs could not be opened');
    openPreview(node);
  }
}

/* ------------------------------------------------------------------ */
/* Multi-select and bulk actions                                      */
/* ------------------------------------------------------------------ */

function updateSelectionBar() {
  const bar = $('#selection-bar');
  if (!bar) return;

  bar.classList.toggle('hidden', !state.selectMode);

  const count = state.selected.size;
  const countNode = $('#selection-count');
  if (countNode) countNode.textContent = count === 1 ? '1 selected' : `${count} selected`;

  const inTrash = state.view === 'trash';
  const show = (selector, visible) => {
    const node = $(selector);
    if (node) node.classList.toggle('hidden', !visible);
  };

  show('#sel-star', !inTrash);
  show('#sel-move', !inTrash);
  show('#sel-download', !inTrash);
  show('#sel-restore', inTrash);

  const deleteButton = $('#sel-delete');
  if (deleteButton) deleteButton.textContent = inTrash ? 'Delete forever' : 'Remove';
}

function exitSelectMode() {
  state.selectMode = false;
  state.selected.clear();
  const button = $('#select-btn');
  if (button) button.textContent = 'Select';
  updateSelectionBar();
}

function toggleSelectMode() {
  if (state.selectMode) {
    exitSelectMode();
    render();
    return;
  }

  state.selectMode = true;
  state.selected.clear();
  const button = $('#select-btn');
  if (button) button.textContent = 'Done';
  render();
}

function toggleSelected(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  render();
}

function selectAllVisible() {
  const items = currentItems();
  if (state.selected.size === items.length) state.selected.clear();
  else items.forEach((node) => state.selected.add(node.id));
  render();
}

function pickFolderFor(ids) {
  return new Promise((resolve) => {
    const root = $('#dialog');
    const blocked = new Set(ids);
    for (const id of ids) {
      const node = state.nodes.get(id);
      if (node && node.type === 'folder') descendantIds(id).forEach((child) => blocked.add(child));
    }

    const folders = [...state.nodes.values()]
      .filter((entry) => entry.type === 'folder' && !entry.trashed && !blocked.has(entry.id))
      .sort((a, b) => collator.compare(a.name, b.name));

    const rows = [
      `<button class="picker-item" type="button" data-target="root">${icon('drive')}<span>My Drive</span></button>`,
      ...folders.map(
        (folder) =>
          `<button class="picker-item" type="button" data-target="${folder.id}">${icon('folder')}<span>${escapeHtml(folder.name)}</span></button>`
      ),
    ];

    root.innerHTML = `
      <div class="dialog-backdrop" data-close="1"></div>
      <div class="dialog" role="dialog" aria-modal="true">
        <h2>Move ${ids.length} item${ids.length === 1 ? '' : 's'}</h2>
        <div class="picker-list">${rows.join('')}</div>
        <div class="dialog-actions">
          <button class="btn ghost" type="button" data-action="cancel">Cancel</button>
        </div>
      </div>`;
    root.classList.remove('hidden');

    const close = (value) => {
      root.classList.add('hidden');
      root.innerHTML = '';
      resolve(value);
    };

    root.querySelector('[data-close]').addEventListener('click', () => close(undefined));
    root.querySelector('[data-action="cancel"]').addEventListener('click', () => close(undefined));
    root.querySelectorAll('.picker-item').forEach((button) => {
      button.addEventListener('click', () => {
        close(button.dataset.target === 'root' ? null : button.dataset.target);
      });
    });
  });
}

async function bulkDelete() {
  const ids = [...state.selected];
  if (!ids.length) {
    toast('Nothing selected');
    return;
  }

  const inTrash = state.view === 'trash';
  const sure = await showDialog({
    title: inTrash ? 'Delete forever?' : 'Remove items?',
    message: inTrash
      ? `Permanently delete ${ids.length} item${ids.length === 1 ? '' : 's'}?`
      : `Move ${ids.length} item${ids.length === 1 ? '' : 's'} to trash?`,
    confirmLabel: inTrash ? 'Delete forever' : 'Remove',
    danger: true,
  });
  if (!sure) return;

  if (inTrash) {
    await removeForever(ids);
  } else {
    const now = Date.now();
    for (const id of ids) {
      const node = state.nodes.get(id);
      if (!node) continue;
      node.trashed = true;
      node.trashedAt = now;
      node.updatedAt = now;
      await db.putNode(node);
    }
  }

  exitSelectMode();
  render();
  toast(inTrash ? 'Deleted forever' : 'Moved to trash');
}

async function bulkRestore() {
  const ids = [...state.selected];
  if (!ids.length) {
    toast('Nothing selected');
    return;
  }

  const now = Date.now();
  for (const id of ids) {
    const node = state.nodes.get(id);
    if (!node) continue;
    if (node.parentId && !state.nodes.get(node.parentId)) node.parentId = null;
    node.trashed = false;
    node.trashedAt = null;
    node.updatedAt = now;
    await db.putNode(node);
  }

  exitSelectMode();
  render();
  toast(`Restored ${ids.length} item${ids.length === 1 ? '' : 's'}`);
}

async function bulkStar() {
  const ids = [...state.selected];
  if (!ids.length) {
    toast('Nothing selected');
    return;
  }

  const now = Date.now();
  for (const id of ids) {
    const node = state.nodes.get(id);
    if (!node) continue;
    node.starred = true;
    node.updatedAt = now;
    await db.putNode(node);
  }

  exitSelectMode();
  render();
  toast('Added to starred');
}

async function bulkMove() {
  const ids = [...state.selected];
  if (!ids.length) {
    toast('Nothing selected');
    return;
  }

  const target = await pickFolderFor(ids);
  if (target === undefined) return;

  const now = Date.now();
  for (const id of ids) {
    const node = state.nodes.get(id);
    if (!node) continue;
    if (node.parentId === target) continue;
    node.parentId = target;
    node.name = uniqueName(node.name, target, node.id);
    node.updatedAt = now;
    await db.putNode(node);
  }

  exitSelectMode();
  render();
  toast('Moved');
}

async function bulkDownload() {
  const ids = [...state.selected];
  const files = ids.map((id) => state.nodes.get(id)).filter((node) => node && node.type === 'file');
  if (!files.length) {
    toast('No files selected');
    return;
  }

  for (const node of files) await downloadNode(node);
  exitSelectMode();
  render();
}

/* ------------------------------------------------------------------ */
/* Details                                                             */
/* ------------------------------------------------------------------ */

function showDetailsDialog(node) {
  const root = $('#dialog');

  let location = 'My Drive';
  if (node.parentId) {
    const chain = [];
    let cursor = node.parentId;
    let guard = 0;
    while (cursor && state.nodes.get(cursor) && guard < 64) {
      const parent = state.nodes.get(cursor);
      chain.unshift(parent.name);
      cursor = parent.parentId;
      guard += 1;
    }
    if (chain.length) location = `My Drive / ${chain.map((name) => escapeHtml(name)).join(' / ')}`;
  }

  let extra;
  if (node.type === 'folder') {
    const count = [...state.nodes.values()].filter((entry) => !entry.trashed && entry.parentId === node.id).length;
    extra = `<div class="detail-row"><span>Contents</span><b>${count} item${count === 1 ? '' : 's'}</b></div>`;
  } else {
    extra = `<div class="detail-row"><span>Size</span><b>${formatBytes(node.size)}</b></div>`;
  }

  root.innerHTML = `
    <div class="dialog-backdrop" data-close="1"></div>
    <div class="dialog" role="dialog" aria-modal="true">
      <h2>${escapeHtml(node.name)}</h2>
      <div class="detail-list">
        <div class="detail-row"><span>Type</span><b>${escapeHtml(node.type === 'folder' ? 'Folder' : node.mime || 'File')}</b></div>
        ${extra}
        <div class="detail-row"><span>Location</span><b>${location}</b></div>
        <div class="detail-row"><span>Created</span><b>${escapeHtml(formatDateTime(node.createdAt))}</b></div>
        <div class="detail-row"><span>Modified</span><b>${escapeHtml(formatDateTime(node.updatedAt))}</b></div>
      </div>
      <div class="dialog-actions">
        <button class="btn primary" type="button" data-action="close">Close</button>
      </div>
    </div>`;
  root.classList.remove('hidden');

  const close = () => {
    root.classList.add('hidden');
    root.innerHTML = '';
  };

  root.querySelector('[data-close]').addEventListener('click', close);
  root.querySelector('[data-action="close"]').addEventListener('click', close);
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

async function readText(blob) {
  const limit = 400 * 1024;
  const slice = blob.size > limit ? blob.slice(0, limit) : blob;
  const text = await slice.text();
  return blob.size > limit ? `${text}\n\n… (preview truncated)` : text;
}

let previewToken = 0;

async function openPreview(node) {
  const modal = $('#preview');
  if (!modal) return;

  closeViewer();
  const token = (previewToken += 1);
  const isCurrent = () => token === previewToken && state.previewId === node.id;

  state.previewId = node.id;

  const files = sortItems(currentItems()).filter((entry) => entry.type === 'file' && !entry.trashed);
  state.previewIds = files.map((entry) => entry.id);
  state.previewIndex = state.previewIds.indexOf(node.id);
  updatePreviewNav();
  $('#preview-name').textContent = node.name;
  $('#preview-sub').textContent = `${formatBytes(node.size)} · ${formatDate(node.updatedAt)}`;

  const body = $('#preview-body');
  body.innerHTML = '<p class="muted">Loading…</p>';
  modal.classList.remove('hidden');

  const kind = fileKind(node.mime, node.name);
  const record = await db.getBlob(node.id);

  if (!record || !record.blob) {
    body.innerHTML = '<p class="muted">This file has no stored data.</p>';
    return;
  }

  const blob = record.blob;
  let url = objUrls.get(node.id);
  if (!url) {
    url = URL.createObjectURL(blob);
    objUrls.set(node.id, url);
  }

  const openLink = $('#preview-open');
  openLink.href = url;
  openLink.classList.remove('hidden');

  if (kind === 'image') {
    body.innerHTML = `<img class="preview-media" src="${url}" alt="${escapeHtml(node.name)}" />`;
  } else if (kind === 'video') {
    body.innerHTML = `<video class="preview-media" src="${url}" controls playsinline></video>`;
  } else if (kind === 'audio') {
    body.innerHTML = `<audio class="preview-audio" src="${url}" controls></audio>`;
  } else if (kind === 'pdf') {
    // Every page is drawn by PDF.js so the whole file scrolls and zooms. If
    // it cannot load (offline, blocked), the browser's own viewer is used.
    body.innerHTML = '<p class="muted">Loading pages…</p>';
    try {
      body.innerHTML = '';
      await mountPdf(body, blob, isCurrent);
    } catch (error) {
      if (error && error.stale) return;
      console.warn('PDF.js could not open this file, using the browser viewer', error);
      if (!isCurrent()) return;
      closeViewer();
      body.innerHTML = `<iframe class="preview-frame" src="${url}" title="${escapeHtml(node.name)}"></iframe>`;
    }
  } else if (officeType(node.name)) {
    // Word documents are laid out properly by docx-preview (pages, tables,
    // images, fonts). Everything else is read from its XML by office.js.
    if (officeType(node.name) === 'docx') {
      const holder = document.createElement('div');
      holder.className = 'docx-holder';
      body.innerHTML = '';
      body.appendChild(holder);

      const laidOut = await renderDocxFaithful(blob, holder);
      if (!isCurrent()) return;
      if (laidOut) {
        mountScaled(body, holder, { mode: 'max', pageSelector: 'section.docx', pageLabel: 'Page' });
        return;
      }
    }

    try {
      const html = await renderOfficePreview(node.name, blob);
      if (!isCurrent()) return;
      body.innerHTML = html;

      const type = officeType(node.name);
      const content = body.firstElementChild;
      if (content) {
        const isSheet = type === 'xlsx' || type === 'ods';
        const isDeck = type === 'pptx' || type === 'odp';
        mountScaled(body, content, {
          mode: isSheet ? 'max' : 'fill',
          pageSelector: isDeck ? '.slide-frame, .slide-page, .office-slide' : isSheet ? '.office-sheet' : '',
          pageLabel: isDeck ? 'Slide' : 'Sheet',
          minInitial: isSheet ? 0.6 : 0,
        });
      }
    } catch (error) {
      if (!isCurrent()) return;
      closeViewer();
      console.warn('Could not read document', node.name, error);
      openLink.classList.add('hidden');
      body.innerHTML = `
        <div class="preview-fallback">
          ${icon(iconForKind(kind))}
          <p>This document could not be read in the browser.</p>
          <p class="muted">${escapeHtml(error && error.message ? error.message : 'Unknown error')}</p>
          ${
            cloud.docsReady()
              ? '<button class="btn ghost" type="button" data-docs="1">Open in Deluxe Docs</button>'
              : ''
          }
          <button class="btn primary" type="button" data-download="1">Download ${escapeHtml(node.name)}</button>
        </div>`;
      body.querySelector('[data-download]').addEventListener('click', () => downloadNode(node));
      const docsButton = body.querySelector('[data-docs]');
      if (docsButton) docsButton.addEventListener('click', () => openInDocs(node));
    }
  } else if (isTextual(kind, node.mime, node.name)) {
    try {
      const text = await readText(blob);
      if (!isCurrent()) return;
      const extension = String(node.name).toLowerCase().split('.').pop();
      if ((extension === 'csv' || extension === 'tsv') && text.length < 2000000) {
        body.innerHTML = renderDelimited(text, extension === 'tsv' ? '\t' : ',');
        if (body.firstElementChild) {
          mountScaled(body, body.firstElementChild, { mode: 'max', pageSelector: '', pageLabel: 'Sheet', minInitial: 0.6 });
        }
      } else {
        body.innerHTML = `<pre class="preview-text">${escapeHtml(text)}</pre>`;
      }
    } catch (error) {
      body.innerHTML = `<p class="muted">Could not read this file as text.</p>`;
    }
    openLink.classList.add('hidden');
  } else {
    openLink.classList.add('hidden');
    body.innerHTML = `
      <div class="preview-fallback">
        ${icon(iconForKind(kind))}
        <p>No preview for this file type — download it to open with another app.</p>
        <button class="btn primary" type="button" data-download="1">Download ${escapeHtml(node.name)}</button>
      </div>`;
    body.querySelector('[data-download]').addEventListener('click', () => downloadNode(node));
  }
}

function closePreview() {
  const modal = $('#preview');
  if (!modal) return;
  modal.classList.add('hidden');
  closeViewer();
  $('#preview-body').innerHTML = '';
  state.previewId = null;
}

function updatePreviewNav() {
  const previous = $('#preview-prev');
  const next = $('#preview-next');
  const canPrevious = state.previewIndex > 0;
  const canNext = state.previewIndex >= 0 && state.previewIndex < state.previewIds.length - 1;
  if (previous) previous.disabled = !canPrevious;
  if (next) next.disabled = !canNext;
}

function stepPreview(delta) {
  if (!state.previewIds.length) return;
  const index = state.previewIndex + delta;
  if (index < 0 || index >= state.previewIds.length) return;
  const node = state.nodes.get(state.previewIds[index]);
  if (node) openPreview(node);
}

/* ------------------------------------------------------------------ */
/* Uploads                                                             */
/* ------------------------------------------------------------------ */

async function saveFile(file, parentId) {
  const id = uid();
  await db.putBlob(id, file);
  const now = Date.now();
  const node = {
    id,
    ownerId: state.currentUser ? state.currentUser.id : null,
    parentId,
    type: 'file',
    name: uniqueName(file.name || 'Untitled', parentId),
    mime: file.type || mimeFromName(file.name),
    size: file.size || 0,
    starred: false,
    trashed: false,
    trashedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.putNode(node);
  state.nodes.set(id, node);
  return node;
}

async function ensureFolder(name, parentId) {
  for (const node of state.nodes.values()) {
    if (
      node.type === 'folder' &&
      !node.trashed &&
      node.parentId === parentId &&
      node.name.toLowerCase() === name.toLowerCase()
    ) {
      return node.id;
    }
  }
  const now = Date.now();
  const node = {
    id: uid(),
    ownerId: state.currentUser ? state.currentUser.id : null,
    parentId,
    type: 'folder',
    name: uniqueName(name, parentId),
    mime: '',
    size: 0,
    starred: false,
    trashed: false,
    trashedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.putNode(node);
  state.nodes.set(node.id, node);
  return node.id;
}

async function handleUpload(fileList) {
  // Snapshot the list: resetting an <input type="file"> empties its live
  // FileList, so anything read later would come back empty.
  const files = Array.from(fileList || []);
  if (!files.length) {
    toast('No files were selected');
    return;
  }

  const targetParent = state.view === 'drive' ? state.folderId : null;

  // The server states the largest file it will take, so a file that can never
  // be stored is refused straight away instead of after a long upload.
  const limit = cloud.isOnline() ? cloud.uploadLimit() : 0;
  toast(`Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`);

  let added = 0;
  let failed = 0;
  let tooBig = 0;

  for (const file of files) {
    if (limit && file.size > limit) {
      failed += 1;
      tooBig += 1;
      continue;
    }
    let parentId = targetParent;
    const relative = file.webkitRelativePath || '';
    if (relative) {
      // Folder uploads carry a relative path such as "photos/2024/a.jpg";
      // recreate each directory level before saving the file.
      const dirs = relative.split('/').slice(0, -1);
      for (const dir of dirs) parentId = await ensureFolder(dir, parentId);
    }
    try {
      await saveFile(file, parentId);
      added += 1;
    } catch (error) {
      failed += 1;
      console.error('Upload failed', file.name, error);
      const message = String((error && error.message) || '').toLowerCase();
      if ((error && error.name === 'QuotaExceededError') || message.includes('quota')) {
        toast('This browser is out of storage for that file');
      }
    }
  }

  render();

  if (added && !failed) {
    toast(`${added} file${added === 1 ? '' : 's'} added`);
  } else if (added && failed) {
    toast(`${added} added, ${failed} could not be saved`);
  } else if (tooBig && failed === tooBig) {
    toast(`Nothing added: the server accepts files up to ${formatBytes(limit)}`);
  } else {
    toast('Nothing could be added — this browser refused to store the file');
  }
}

async function createFolderFlow() {
  const parentId = state.view === 'drive' ? state.folderId : null;
  const name = await showDialog({ title: 'New folder', input: 'Untitled folder', confirmLabel: 'Create' });
  if (!name) return;

  const now = Date.now();
  const node = {
    id: uid(),
    ownerId: state.currentUser ? state.currentUser.id : null,
    parentId,
    type: 'folder',
    name: uniqueName(name, parentId),
    mime: '',
    size: 0,
    starred: false,
    trashed: false,
    trashedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.putNode(node);
  state.nodes.set(node.id, node);
  render();
  toast('Folder created');
}

async function emptyTrash() {
  const trashed = [...state.nodes.values()].filter((node) => node.trashed);
  if (!trashed.length) {
    toast('Trash is already empty');
    return;
  }
  const sure = await showDialog({
    title: 'Empty trash?',
    message: `Permanently delete ${trashed.length} item${trashed.length === 1 ? '' : 's'}?`,
    confirmLabel: 'Empty trash',
    danger: true,
  });
  if (!sure) return;

  const ids = new Set();
  for (const node of trashed) {
    ids.add(node.id);
    descendantIds(node.id).forEach((id) => ids.add(id));
  }
  for (const id of ids) {
    await db.deleteNode(id);
    await db.deleteBlob(id);
    const url = objUrls.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      objUrls.delete(id);
    }
    state.nodes.delete(id);
  }
  render();
  toast('Trash emptied');
}

/* ------------------------------------------------------------------ */
/* Account actions                                                     */
/* ------------------------------------------------------------------ */

async function changePasswordFlow() {
  if (cloud.isOnline()) {
    await changePasswordOnServer();
    return;
  }

  const current = await showDialog({
    title: 'Change password',
    message: 'Enter your current password.',
    input: '',
    confirmLabel: 'Next',
  });
  if (!current) return;

  let valid = false;
  try {
    valid = await auth.verifyUser(state.currentUser ? state.currentUser.id : '', current);
  } catch (error) {
    toast(error.message);
    return;
  }
  if (!valid) {
    toast('That password is not correct');
    return;
  }

  const next = await showDialog({ title: 'New password', message: 'At least 4 characters.', input: '', confirmLabel: 'Next' });
  if (!next) return;
  if (next.length < 4) {
    toast('Use at least 4 characters');
    return;
  }

  const again = await showDialog({ title: 'Confirm new password', input: '', confirmLabel: 'Save' });
  if (again !== next) {
    toast('Passwords do not match');
    return;
  }

  await auth.changePassword(state.currentUser ? state.currentUser.id : '', current, next);
  toast('Password updated');
}

// A server account's password is checked by the server, so the new salt and
// hash are made here and sent with the current hash as proof.
async function changePasswordOnServer() {
  const current = await showDialog({
    title: 'Change password',
    message: 'Enter your current password.',
    input: '',
    confirmLabel: 'Next',
  });
  if (!current) return;

  const next = await showDialog({ title: 'New password', message: 'At least 4 characters.', input: '', confirmLabel: 'Next' });
  if (!next) return;
  if (next.length < 4) {
    toast('Use at least 4 characters');
    return;
  }

  const again = await showDialog({ title: 'Confirm new password', input: '', confirmLabel: 'Save' });
  if (again !== next) {
    toast('Passwords do not match');
    return;
  }

  try {
    const account = await cloud.accountById(state.currentUser ? state.currentUser.id : '');
    if (!account || !account.salt) throw new Error('That account is not on the server.');

    const currentHash = await auth.hashPassword(current, account.salt);
    const salt = auth.makeSalt();
    const hash = await auth.hashPassword(next, salt);

    await cloud.changePassword({ id: state.currentUser.id, currentHash, salt, hash });
    toast('Password updated');
  } catch (error) {
    toast(error.message || 'That password could not be changed');
  }
}

async function resetDrive() {
  if (!state.currentUser) return;

  const online = cloud.isOnline();
  const sure = await showDialog({
    title: 'Erase my files?',
    message: `Every file and folder in ${state.currentUser.name}'s drive will be deleted from ${
      online ? 'the Deluxe Drive server' : 'this device'
    }. The account and its password stay.`,
    confirmLabel: 'Erase my files',
    danger: true,
  });
  if (!sure) return;

  if (online) await db.clearAll();
  else await deleteNodesOfUser(state.currentUser.id);

  await loadNodes();
  render();
  toast('Your drive is empty');
}

function lockDrive() {
  auth.forgetSession();
  location.reload();
}

/* ------------------------------------------------------------------ */
/* Credits                                                             */
/* ------------------------------------------------------------------ */

const CREDITS_SITES = [
  {
    name: 'YouTube Guider AI',
    url: 'https://youtube-guide-ai.netlify.app/',
    label: 'youtube-guide-ai.netlify.app',
  },
  {
    name: 'Deluxe Convert',
    url: 'https://deluxe-convert-cloud.deluxelordd.workers.dev',
    label: 'deluxe-convert-cloud.deluxelordd.workers.dev',
  },
  {
    name: 'Deluxe Translate',
    url: 'https://deluxe-translate-8m27.netlify.app/',
    label: 'deluxe-translate-8m27.netlify.app',
  },
];

// "More websites": the button in the top bar (and the link on the lock
// screen) opens the other sites by Deluxe Lord.
function showMoreSites() {
  const root = $('#dialog');
  if (!root) return;

  const links = CREDITS_SITES.map(
    (site) => `
      <a class="credit-link" href="${site.url}" target="_blank" rel="noopener">
        <span class="credit-link-name">${escapeHtml(site.name)}</span>
        <span class="credit-link-url">${escapeHtml(site.label)}</span>
      </a>`
  ).join('');

  root.innerHTML = `
    <div class="dialog-backdrop" data-close="1"></div>
    <div class="dialog credits-dialog" role="dialog" aria-modal="true" aria-label="More websites">
      <h2>More websites</h2>
      <p class="credits-tagline">Other sites by Deluxe Lord.</p>
      <div class="credits-links">${links}</div>
      <div class="dialog-actions">
        <button class="btn primary" type="button" data-action="close">Close</button>
      </div>
    </div>`;
  root.classList.remove('hidden');

  const close = () => {
    root.classList.add('hidden');
    root.innerHTML = '';
  };

  root.querySelector('[data-close]').addEventListener('click', close);
  root.querySelector('[data-action="close"]').addEventListener('click', close);
}

function showCredits() {
  const root = $('#dialog');
  if (!root) return;

  const links = CREDITS_SITES.map(
    (site) => `
      <a class="credit-link" href="${site.url}" target="_blank" rel="noopener">
        <span class="credit-link-name">${escapeHtml(site.name)}</span>
        <span class="credit-link-url">${escapeHtml(site.label)}</span>
      </a>`
  ).join('');

  root.innerHTML = `
    <div class="dialog-backdrop" data-close="1"></div>
    <div class="dialog credits-dialog" role="dialog" aria-modal="true" aria-label="Credits">
      <div class="credits-head">
        <img src="icon.svg" alt="" width="48" height="48" />
        <div>
          <h2>Deluxe Drive</h2>
          <p class="credits-tagline">Your drive, in the browser.</p>
        </div>
      </div>

      <div class="credits-list">
        <div class="credit-row"><span>Directed by</span><b>Shivad Sujith</b></div>
        <div class="credit-row"><span>AI support</span><b>Claude</b></div>
        <div class="credit-row"><span>Built with</span><b>FreeMilk</b></div>
        <div class="credit-row"><span>Powered by</span><b>Netlify</b></div>
      </div>

      <h3 class="credits-sub">More from Deluxe Lord</h3>
      <div class="credits-links">${links}</div>

      <div class="dialog-actions">
        <button class="btn primary" type="button" data-action="close">Close</button>
      </div>
    </div>`;
  root.classList.remove('hidden');

  const close = () => {
    root.classList.add('hidden');
    root.innerHTML = '';
  };

  root.querySelector('[data-close]').addEventListener('click', close);
  root.querySelector('[data-action="close"]').addEventListener('click', close);
}

/* ------------------------------------------------------------------ */
/* Deluxe Docs connection                                              */
/* ------------------------------------------------------------------ */

// Connect the documents app: the drive registers it as an OAuth viewer and
// hands it a share link for each document opened here. Sign-in for the viewer
// happens on Deluxe Drive's own pages, so its password never leaves this site.
function showDocsDialog() {
  const root = $('#dialog');
  if (!root) return;

  const online = cloud.isOnline();
  const settings = cloud.docsSettings();

  // The Deluxe Docs page this drive is usually connected to; typing over it is
  // how another address is registered.
  const docsDefault = 'https://deluxe-docs.netlify.app';

  const status = !online
    ? `This copy (${location.host}) is served as plain files, so it has no server of its own and keeps files in this browser. Enter the address of a Deluxe Drive server below — or open the drive from that server.`
    : settings.url
      ? `Connected to ${settings.url}. The share link needs no sign-in, and Deluxe Docs can only read the files you open.`
      : 'Not connected yet. Paste the Deluxe Docs page address, for example https://deluxe-docs.netlify.app.';

  // A static copy can still use a server somewhere else, once it is told where.
  const serverField = online
    ? ''
    : `
      <label class="docs-field">
        <span>Deluxe Drive server address</span>
        <input id="docs-server" type="url" inputmode="url" autocapitalize="none" autocorrect="off" spellcheck="false"
          placeholder="https://your-drive.freemilk.app" value="${escapeHtml(cloud.savedServer())}" />
      </label>`;

  // Deluxe Docs keeps its Drive sign-in in its own config.js, so the client it
  // was just registered as has to be copyable from here.
  const setup =
    online && settings.clientId
      ? `
      <div class="docs-setup">
        <p class="docs-setup-id">Client ID <code>${escapeHtml(settings.clientId)}</code></p>
        <button class="btn ghost" type="button" data-action="copy-setup">Copy Docs setup</button>
        <p class="docs-setup-hint">
          Paste it into Deluxe Docs’ <code>config.js</code> so that app can sign in to this drive.
        </p>
      </div>`
      : '';

  root.innerHTML = `
    <div class="dialog-backdrop" data-close="1"></div>
    <div class="dialog docs-dialog" role="dialog" aria-modal="true" aria-label="Deluxe Docs">
      <h2>Deluxe Docs</h2>
      <p class="dialog-msg">
        Connect the documents app and every document you open here is handed to it over a share link.
        ${online ? '' : ' Enter the address of a Deluxe Drive server below, then use it, or open the drive from that server.'}
      </p>

      <label class="docs-field">
        <span>Deluxe Docs page address</span>
        <input id="docs-url" type="url" inputmode="url" autocapitalize="none" autocorrect="off" spellcheck="false"
          placeholder="https://…" value="${escapeHtml(settings.url || docsDefault)}" />
      </label>

      <label class="docs-check">
        <input id="docs-auto" type="checkbox" ${settings.autoOpen ? 'checked' : ''} />
        <span>Open documents in Deluxe Docs automatically</span>
      </label>

      <p id="docs-status" class="docs-status">${escapeHtml(status)}</p>
      ${serverField}
      ${setup}

      <div class="dialog-actions">
        ${
          online && settings.url
            ? '<button class="btn ghost" type="button" data-action="disconnect">Disconnect</button>'
            : ''
        }
        ${
          online && settings.url
            ? '<button class="btn ghost" type="button" data-action="open-docs">Open Deluxe Docs</button>'
            : ''
        }
        ${
          online
            ? ''
            : '<button class="btn ghost" type="button" data-action="check">Use this server</button>'
        }
        <button class="btn ghost" type="button" data-action="close">Close</button>
        <button class="btn primary" type="button" data-action="connect">${
          settings.url ? 'Reconnect' : 'Connect'
        }</button>
      </div>
    </div>`;
  root.classList.remove('hidden');

  const statusNode = root.querySelector('#docs-status');
  const urlField = root.querySelector('#docs-url');
  const autoField = root.querySelector('#docs-auto');
  const connectButton = root.querySelector('[data-action="connect"]');

  const close = () => {
    root.classList.add('hidden');
    root.innerHTML = '';
  };

  root.querySelector('[data-close]').addEventListener('click', close);
  root.querySelector('[data-action="close"]').addEventListener('click', close);

  if (autoField) {
    autoField.addEventListener('change', () => {
      cloud.saveDocsSettings({ ...cloud.docsSettings(), autoOpen: autoField.checked });
    });
  }

  const disconnect = root.querySelector('[data-action="disconnect"]');
  if (disconnect) {
    disconnect.addEventListener('click', async () => {
      disconnect.disabled = true;
      try {
        await cloud.disconnectDocs();
        toast('Deluxe Docs disconnected');
      } catch (error) {
        toast(error.message || 'Could not disconnect Deluxe Docs');
      }
      close();
    });
  }

  const copySetup = root.querySelector('[data-action="copy-setup"]');
  if (copySetup) {
    copySetup.addEventListener('click', async () => {
      await copyText(JSON.stringify(cloud.docsConfig(), null, 2));
      toast('Deluxe Docs setup copied');
    });
  }

  const openDocsButton = root.querySelector('[data-action="open-docs"]');  if (openDocsButton) {
    openDocsButton.addEventListener('click', () => {
      window.open(settings.url, '_blank', 'noopener');
    });
  }

  // A server that answers now but did not when the page opened (a cold start,
  // a host that was still waking up) is worth another look: reloading puts the
  // whole drive on it, sign-in included, instead of silently staying local.
  const checkButton = root.querySelector('[data-action="check"]');
  if (checkButton) {
    checkButton.addEventListener('click', async () => {
      checkButton.disabled = true;

      const field = root.querySelector('#docs-server');
      const typed = field ? String(field.value || '').trim() : '';
      const show = (message) => {
        if (statusNode) statusNode.textContent = message;
      };

      if (typed) {
        const saved = cloud.setServer(typed);
        if (!saved) {
          show('Enter the server address with https://, for example https://your-drive.freemilk.app.');
          checkButton.disabled = false;
          return;
        }
      }

      show('Looking for the Deluxe Drive server…');

      const server = await cloud.refreshServer();
      if (!server) {
        show(
          typed
            ? `No Deluxe Drive server answered at ${typed}. Check the address, and that the server is running.`
            : 'No Deluxe Drive server answered. Open the drive from its server, or enter a server address above.'
        );
        checkButton.disabled = false;
        return;
      }

      show('Server found — reloading the drive with it…');
      location.reload();
    });
  }

  if (urlField) {
    urlField.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      connectButton.click();
    });
  }

  connectButton.addEventListener('click', async () => {
    const pageUrl = urlField ? String(urlField.value || '').trim() : '';

    if (!pageUrl) {
      const message = 'Type the Deluxe Docs page address, for example https://deluxe-docs.netlify.app.';
      if (statusNode) statusNode.textContent = message;
      toast(message);
      if (urlField) urlField.focus();
      return;
    }

    // Without a server there is nothing to register yet: take the address
    // typed above, find that server, and come back on it.
    if (!cloud.isOnline()) {
      const field = root.querySelector('#docs-server');
      const typed = field ? String(field.value || '').trim() : '';

      if (!typed) {
        const message = 'Enter the Deluxe Drive server address above first, or open the drive from its server.';
        if (statusNode) statusNode.textContent = message;
        toast(message);
        if (field) field.focus();
        return;
      }

      if (!cloud.setServer(typed)) {
        const message = 'Enter the server address with https://, for example https://your-drive.freemilk.app.';
        if (statusNode) statusNode.textContent = message;
        toast(message);
        return;
      }

      connectButton.disabled = true;
      if (statusNode) statusNode.textContent = 'Looking for the Deluxe Drive server…';

      const server = await cloud.refreshServer();
      if (!server) {
        if (statusNode) statusNode.textContent = `No Deluxe Drive server answered at ${typed}. Check the address, and that it is published.`;
        connectButton.disabled = false;
        return;
      }

      if (statusNode) statusNode.textContent = 'Server found — reloading the drive with it…';
      location.reload();
      return;
    }

    connectButton.disabled = true;
    if (statusNode) statusNode.textContent = 'Connecting…';

    try {
      const saved = await cloud.connectDocs(pageUrl);
      cloud.saveDocsSettings({ ...saved, autoOpen: autoField ? autoField.checked : true });
      toast('Deluxe Docs connected');
      close();
    } catch (error) {
      let message = (error && error.message) || 'Could not connect Deluxe Docs.';
      if (error && error.status === 401) message = 'Sign in to Deluxe Drive again, then connect Deluxe Docs.';
      if (statusNode) statusNode.textContent = message;
      connectButton.disabled = false;
      toast(message);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Shared links                                                        */
/* ------------------------------------------------------------------ */

// Every link this account has handed out. One list, so a link made for
// Deluxe Docs - or for anyone else - can still be found and closed.
async function showSharesDialog() {
  const root = $('#dialog');
  if (!root) return;

  if (!cloud.isOnline()) {
    await showDialog({
      title: 'Shared links need the server',
      message: 'A link anyone can open exists only when the drive runs on its own server.',
      confirmLabel: 'OK',
      cancelLabel: '',
    });
    return;
  }

  let shares = [];
  try {
    shares = await cloud.listShares();
  } catch (error) {
    toast(error.message || 'Could not read the shared links');
    return;
  }

  state.shared = new Set(shares.map((share) => share.fileId).filter(Boolean));
  render();

  const rows = shares.length
    ? shares
        .map(
          (share) => `
      <li class="share-row">
        <span class="share-icon">${icon('link')}</span>
        <div class="share-file">
          <p class="share-name">${escapeHtml(share.name || 'Untitled')}</p>
          <p class="share-when">Shared ${escapeHtml(formatDate(share.createdAt))}</p>
        </div>
        <div class="share-actions">
          <button class="btn ghost" type="button" data-copy="${escapeHtml(share.url)}">Copy</button>
          <button class="btn ghost share-stop" type="button" data-stop="${escapeHtml(share.fileId)}">Stop</button>
        </div>
      </li>`
        )
        .join('')
    : '<li class="share-empty">No share links yet. Copy one from a file’s menu, or open a document in Deluxe Docs.</li>';

  root.innerHTML = `
    <div class="dialog-backdrop" data-close="1"></div>
    <div class="dialog shares-dialog" role="dialog" aria-modal="true" aria-label="Shared links">
      <h2>Shared links</h2>
      <p class="dialog-msg">
        Anyone with one of these links can open that file without signing in. Stopping a link closes
        it for everyone.
      </p>
      <ul class="shares-list">${rows}</ul>
      <div class="dialog-actions">
        <button class="btn primary" type="button" data-action="close">Close</button>
      </div>
    </div>`;
  root.classList.remove('hidden');

  const close = () => {
    root.classList.add('hidden');
    root.innerHTML = '';
  };

  root.querySelector('[data-close]').addEventListener('click', close);
  root.querySelector('[data-action="close"]').addEventListener('click', close);

  root.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      await copyText(button.dataset.copy || '');
      toast('Share link copied');
    });
  });

  root.querySelectorAll('[data-stop]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      const fileId = button.dataset.stop || '';

      try {
        await cloud.stopSharing(fileId);
        state.shared.delete(fileId);
        render();
        close();
        toast('Share link stopped');
      } catch (error) {
        button.disabled = false;
        toast(error.message || 'That link could not be stopped');
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* Event wiring                                                        */
/* ------------------------------------------------------------------ */

function bindUI() {
  if (uiBound) return;
  uiBound = true;

  $('#theme-btn').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');

  $('#theme-btn').addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('dd.theme', theme);
    updateThemeColor(theme);
    $('#theme-btn').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
  });

  $('#menu-btn').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
  $('#sidebar-backdrop').addEventListener('click', () => document.body.classList.remove('sidebar-open'));

  document.querySelectorAll('.nav-item').forEach((button) => {
    button.addEventListener('click', () => {
      state.view = button.dataset.view;
      state.query = '';
      $('#search-input').value = '';
      if (state.view === 'drive') state.folderId = null;
      exitSelectMode();
      document.body.classList.remove('sidebar-open');
      closePopup();
      render();
    });
  });

  $('#search-input').addEventListener('input', (event) => {
    const query = event.target.value.trim();
    state.query = query;
    if (query) {
      if (state.view !== 'search') state.prevView = state.view;
      state.view = 'search';
    } else if (state.view === 'search') {
      state.view = state.prevView;
    }
    render();
  });

  $('#sort-select').addEventListener('change', (event) => {
    state.sort = event.target.value;
    localStorage.setItem('dd.sort', state.sort);
    render();
  });

  $('#view-toggle').addEventListener('click', () => {
    state.layout = state.layout === 'grid' ? 'list' : 'grid';
    localStorage.setItem('dd.layout', state.layout);
    render();
  });

  const openPicker = () => $('#file-input').click();
  $('#upload-btn').addEventListener('click', openPicker);
  $('#empty-upload').addEventListener('click', openPicker);

  $('#file-input').addEventListener('change', async (event) => {
    // Snapshot the selection BEFORE resetting the input: setting value = ''
    // empties the live FileList, so uploading it afterwards finds nothing.
    const chosen = Array.from(event.target.files || []);
    event.target.value = '';
    await handleUpload(chosen);
  });

  $('#folder-input').addEventListener('change', async (event) => {
    const chosen = Array.from(event.target.files || []);
    event.target.value = '';
    await handleUpload(chosen);
  });

  $('#new-btn').addEventListener('click', (event) => {
    openPopup(
      event.currentTarget,
      [
        { action: 'folder', label: 'New folder', icon: 'folder' },
        { action: 'files', label: 'Upload files', icon: 'upload' },
        { action: 'dir', label: 'Upload folder', icon: 'folder-open' },
      ],
      (action) => {
        if (action === 'folder') createFolderFlow();
        else if (action === 'files') openPicker();
        else if (action === 'dir') $('#folder-input').click();
      }
    );
  });

  $('#account-btn').addEventListener('click', (event) => {
    openPopup(
      event.currentTarget,
      [
        { action: 'password', label: 'Change password', icon: 'lock' },
        {
          action: 'docs',
          label: cloud.docsSettings().url ? 'Deluxe Docs (connected)' : 'Connect Deluxe Docs',
          icon: 'doc',
        },
        ...(cloud.isOnline() ? [{ action: 'shares', label: 'Shared links', icon: 'link' }] : []),
        { action: 'credits', label: 'Credits', icon: 'info' },
        { action: 'lock', label: 'Lock drive', icon: 'logout' },
        { action: 'reset', label: 'Erase my files', icon: 'trash', danger: true },
      ],
      (action) => {
        if (action === 'password') changePasswordFlow();
        else if (action === 'docs') showDocsDialog();
        else if (action === 'shares') showSharesDialog();
        else if (action === 'credits') showCredits();
        else if (action === 'lock') lockDrive();
        else if (action === 'reset') resetDrive();
      }
    );
  });

  $('#more-sites-btn').addEventListener('click', showMoreSites);

  $('#empty-trash').addEventListener('click', emptyTrash);

  $('#select-btn').addEventListener('click', toggleSelectMode);
  $('#sel-all').addEventListener('click', selectAllVisible);
  $('#sel-star').addEventListener('click', bulkStar);
  $('#sel-move').addEventListener('click', bulkMove);
  $('#sel-download').addEventListener('click', bulkDownload);
  $('#sel-restore').addEventListener('click', bulkRestore);
  $('#sel-delete').addEventListener('click', bulkDelete);
  $('#sel-cancel').addEventListener('click', () => {
    exitSelectMode();
    render();
  });

  $('#preview-prev').addEventListener('click', () => stepPreview(-1));
  $('#preview-next').addEventListener('click', () => stepPreview(1));

  $('#file-grid').addEventListener('click', (event) => {
    const menuButton = event.target.closest('[data-menu]');
    if (menuButton) {
      event.stopPropagation();
      openNodeMenu(menuButton.dataset.menu, menuButton);
    }
  });

  $('#file-grid').addEventListener('click', (event) => {
    if (event.target.closest('[data-menu]')) return;
    const card = event.target.closest('.card');
    if (!card) return;
    openNode(card.dataset.id);
  });

  $('#file-grid').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('.card');
    if (!card) return;
    event.preventDefault();
    openNode(card.dataset.id);
  });

  $('#file-grid').addEventListener('pointerdown', (event) => {
    const card = event.target.closest('.card');
    if (!card || event.target.closest('[data-menu]')) return;
    const id = card.dataset.id;
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressTimer = null;
      state.suppressClick = Date.now() + 700;
      openNodeMenu(id, card);
    }, 500);
  });

  ['pointerup', 'pointercancel', 'pointermove', 'scroll'].forEach((name) => {
    window.addEventListener(
      name,
      () => {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
      },
      { passive: true }
    );
  });

  $('#crumbs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-crumb]');
    if (!button) return;
    state.folderId = button.dataset.crumb === 'root' ? null : button.dataset.crumb;
    state.view = 'drive';
    state.query = '';
    $('#search-input').value = '';
    exitSelectMode();
    render();
  });

  $('#preview-close').addEventListener('click', closePreview);
  $('#preview').addEventListener('click', (event) => {
    if (event.target.closest('[data-preview-close]')) closePreview();
  });
  $('#preview-download').addEventListener('click', () => {
    const node = state.previewId ? state.nodes.get(state.previewId) : null;
    if (node) downloadNode(node);
  });

  document.addEventListener('click', (event) => {
    const menu = $('#context-menu');
    if (!menu || menu.classList.contains('hidden')) return;
    if (menu.contains(event.target)) return;
    if (
      event.target.closest('[data-menu]') ||
      event.target.closest('#account-btn') ||
      event.target.closest('#new-btn')
    ) {
      return;
    }
    closePopup();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closePopup();
      if (!$('#preview').classList.contains('hidden')) closePreview();
      if (state.selectMode) {
        exitSelectMode();
        render();
      }
      document.body.classList.remove('sidebar-open');
      return;
    }

    if (!$('#preview').classList.contains('hidden')) {
      if (event.key === 'ArrowRight') {
        stepPreview(1);
        return;
      }
      if (event.key === 'ArrowLeft') {
        stepPreview(-1);
        return;
      }
    }
  });

  /* drag & drop */
  window.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer) return;
    if (!Array.from(event.dataTransfer.types || []).includes('Files')) return;
    dragDepth += 1;
    $('#drop-overlay').classList.remove('hidden');
  });

  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#drop-overlay').classList.add('hidden');
  });

  window.addEventListener('dragover', (event) => {
    if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')) {
      event.preventDefault();
    }
  });

  window.addEventListener('drop', async (event) => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    dragDepth = 0;
    $('#drop-overlay').classList.add('hidden');
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length) await handleUpload(files);
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function enterApp(user) {
  state.currentUser = user;
  state.view = 'drive';
  state.folderId = null;
  state.query = '';
  state.nodes = new Map();
  auth.forgetSession();

  // Next time this browser opens the drive, offer this account (and only
  // this account) by name; the password is still required every visit.
  if (user && user.id) rememberUser(user);

  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');

  const avatar = $('#account-btn');
  if (avatar) avatar.textContent = (user && user.name ? user.name.charAt(0) : 'D').toUpperCase();

  // Wire the UI first, so a storage hiccup can never leave the app with
  // dead buttons: the user still gets a working (empty) drive plus a toast.
  bindUI();

  try {
    await loadNodes();
  } catch (error) {
    console.error('Could not read the drive', error);
    state.nodes = new Map();
    toast(error.message || 'Could not read the drive');
  }

  await refreshShares();

  render();
}

// Files from the old single-account version have no owner yet. Only the
// account carried over from that version may claim them.
async function adoptOwnerlessNodes(userId) {
  if (userId !== 'u_legacy') return;

  const all = await db.allNodes();
  const orphans = all.filter((node) => !node.ownerId);
  for (const node of orphans) {
    node.ownerId = userId;
    await db.putNode(node);
  }
}

async function deleteNodesOfUser(userId) {
  const all = await db.allNodes();
  const mine = all.filter((node) => node.ownerId === userId);

  for (const node of mine) {
    await db.deleteNode(node.id);
    await db.deleteBlob(node.id);
    const url = objUrls.get(node.id);
    if (url) {
      URL.revokeObjectURL(url);
      objUrls.delete(node.id);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Accounts on this device                                             */
/* ------------------------------------------------------------------ */

let authUsers = [];
let authMode = 'sign_in'; // sign_in | create
let authHintId = null; // the account last used in this browser

const LAST_USER_KEY = 'dd.lastUser';
const LAST_NAME_KEY = 'dd.lastName';

function readLastUser() {
  try {
    return localStorage.getItem(LAST_USER_KEY);
  } catch (error) {
    return null;
  }
}

function readLastName() {
  try {
    return localStorage.getItem(LAST_NAME_KEY);
  } catch (error) {
    return null;
  }
}

function rememberUser(user) {
  if (!user) return;
  try {
    if (user.id) localStorage.setItem(LAST_USER_KEY, user.id);
    if (user.name) localStorage.setItem(LAST_NAME_KEY, user.name);
  } catch (error) {
    /* storage can be blocked; the drive still works */
  }
}

async function initAuthScreen() {
  const buildNode = $('#auth-build');
  if (buildNode) buildNode.textContent = BUILD;

  if (cloud.isOnline()) {
    // The server never hands out a list of its accounts: only the name last
    // used in this browser is offered again, typed in by the person.
    authUsers = [];
    authHintId = null;
    authMode = readLastName() ? 'sign_in' : 'create';
    renderAuthScreen();
    return;
  }

  authUsers = await auth.listUsers();

  // Only the account last used in this browser is offered by name; every other
  // account stays invisible. A first visit, or a cleared browser, gets the
  // plain "name + password" form.
  const last = readLastUser();
  const hinted = last ? authUsers.find((user) => user.id === last) || null : null;
  authHintId = hinted ? hinted.id : null;

  authMode = authUsers.length ? 'sign_in' : 'create';
  renderAuthScreen();
}

// With a server, the accounts are not listed anywhere: the name last used in
// this browser is offered again, and checked there by the server.
function renderServerAuthScreen() {
  const creating = authMode === 'create';
  const lastName = readLastName();

  $('#name-field').classList.remove('hidden');
  const nameField = $('#auth-name');
  if (!nameField.value) nameField.value = lastName || '';

  $('#auth-password').value = '';
  $('#auth-password2').value = '';
  $('#auth-error').textContent = '';

  $('#password-label').textContent = creating ? 'Choose a password' : 'Password';
  $('#pw2-field').classList.toggle('hidden', !creating);
  $('#auth-submit').textContent = creating ? 'Create account' : 'Unlock';

  $('#auth-sub').textContent = creating
    ? 'Create an account on the Deluxe Drive server. Its files open on every device you sign in on.'
    : lastName
      ? `Welcome back, ${lastName}. Sign in to open your drive from the Deluxe Drive server.`
      : 'Sign in with your name and password. Your drive is kept on the Deluxe Drive server.';

  $('#auth-switch').classList.add('hidden');
  $('#auth-new').classList.remove('hidden');
  $('#auth-new').textContent = creating ? 'Sign in to an existing account' : 'Create a new account';
  $('#auth-reset').classList.remove('hidden');

  if (creating) $('#auth-name').focus();
  else $('#auth-password').focus();
}

function renderAuthScreen() {
  if (cloud.isOnline()) {
    renderServerAuthScreen();
    return;
  }

  const creating = authMode === 'create';
  const hinted = authHintId ? authUsers.find((user) => user.id === authHintId) || null : null;
  const newButton = $('#auth-new');
  const resetButton = $('#auth-reset');
  const switchButton = $('#auth-switch');

  const showName = creating || !hinted;
  $('#name-field').classList.toggle('hidden', !showName);
  $('#auth-name').value = hinted && !creating ? hinted.name : '';
  $('#auth-password').value = '';
  $('#auth-password2').value = '';
  $('#auth-error').textContent = '';

  $('#password-label').textContent = creating ? 'Choose a password' : 'Password';
  $('#pw2-field').classList.toggle('hidden', !creating);
  $('#auth-submit').textContent = creating ? 'Create account' : 'Unlock';

  $('#auth-sub').textContent = creating
    ? 'Create your own account. Nobody else on this device can see it or its files.'
    : hinted
      ? `Welcome back, ${hinted.name}. Enter your password to open your drive.`
      : 'Sign in with your name and password. Each account and its files stay private.';

  switchButton.classList.toggle('hidden', !hinted);
  switchButton.textContent = hinted ? `Not ${hinted.name}? Use a different name` : 'Use a different name';

  newButton.textContent = creating ? 'Sign in to an existing account' : 'Create a new account';
  newButton.classList.toggle('hidden', creating && !authUsers.length);
  resetButton.classList.toggle('hidden', creating);

  if (hinted && !creating) $('#auth-password').focus();
  else $('#auth-name').focus();
}

function bindAuthScreen() {
  $('#auth-credits').addEventListener('click', showCredits);
  $('#auth-more-sites').addEventListener('click', showMoreSites);

  $('#auth-switch').addEventListener('click', () => {
    authHintId = null;
    try {
      localStorage.removeItem(LAST_USER_KEY);
    } catch (error) {
      /* nothing to clear */
    }
    renderAuthScreen();
  });

  $('#auth-new').addEventListener('click', () => {
    authMode = authMode === 'create' ? 'sign_in' : 'create';
    renderAuthScreen();
  });

  $('#auth-reset').addEventListener('click', async () => {
    if (cloud.isOnline()) {
      await showDialog({
        title: 'Accounts live on the server',
        message:
          'A Deluxe Drive server account can only be erased while signed in: unlock it, then use Erase my files, or ask whoever runs the server.',
        confirmLabel: 'OK',
        cancelLabel: '',
      });
      return;
    }

    const typed = $('#auth-name').value.trim();
    const user = typed
      ? authUsers.find((entry) => entry.name.toLowerCase() === typed.toLowerCase())
      : null;

    if (!user) {
      $('#auth-error').textContent = typed
        ? 'There is no account with that name on this device.'
        : 'Type your account name above first, then tap Forgot password.';
      $('#auth-name').focus();
      return;
    }

    const sure = await showDialog({
      title: `Erase the account “${user.name}”?`,
      message:
        'This deletes that account and every file in it from this device. A forgotten password cannot be recovered.',
      confirmLabel: 'Erase account',
      danger: true,
    });
    if (!sure) return;

    await deleteNodesOfUser(user.id);
    await auth.removeUser(user.id);
    await initAuthScreen();
    toast(`The account “${user.name}” was erased`);
  });

  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();

    const error = $('#auth-error');
    const submit = $('#auth-submit');
    const name = $('#auth-name').value.trim();
    const password = $('#auth-password').value;
    error.textContent = '';

    if (!name) {
      error.textContent = 'Type your name.';
      $('#auth-name').focus();
      return;
    }

    // On the server the password is hashed here with the salt it returns, and
    // only that hash travels; the server never sees the password itself.
    if (cloud.isOnline()) {
      if (authMode === 'create') {
        const confirmPassword = $('#auth-password2').value;

        if (name.length < 2) {
          error.textContent = 'That name is too short.';
          return;
        }
        if (password.length < 4) {
          error.textContent = 'Use at least 4 characters.';
          return;
        }
        if (password !== confirmPassword) {
          error.textContent = 'Passwords do not match.';
          return;
        }

        submit.disabled = true;
        try {
          const salt = auth.makeSalt();
          const hash = await auth.hashPassword(password, salt);
          const user = await cloud.createAccount({ name, salt, hash });
          submit.disabled = false;
          await enterApp(user);
          toast(`Welcome, ${user.name}`);
        } catch (error_) {
          submit.disabled = false;
          error.textContent = error_.message || 'Could not create the account.';
        }
        return;
      }

      submit.disabled = true;
      try {
        const record = await cloud.findAccount(name);
        const hash = await auth.hashPassword(password, record.salt);
        const user = await cloud.startSession({ id: record.id, name: record.name, hash });
        submit.disabled = false;
        await enterApp(user);
      } catch (error_) {
        submit.disabled = false;
        error.textContent = "That name and password don't match an account on this server.";
        $('#auth-password').select();
      }
      return;
    }

    if (authMode === 'create') {
      const confirmPassword = $('#auth-password2').value;

      if (name.length < 2) {
        error.textContent = 'That name is too short.';
        return;
      }
      if (password.length < 4) {
        error.textContent = 'Use at least 4 characters.';
        return;
      }
      if (password !== confirmPassword) {
        error.textContent = 'Passwords do not match.';
        return;
      }

      submit.disabled = true;
      try {
        const user = await auth.createUser(name, password);
        await adoptOwnerlessNodes(user.id);
        submit.disabled = false;
        await enterApp(user);
        toast(`Welcome, ${user.name}`);
      } catch (error_) {
        submit.disabled = false;
        error.textContent = error_.message || 'Could not create the account.';
      }
      return;
    }

    const user = authUsers.find((entry) => entry.name.toLowerCase() === name.toLowerCase());

    // The same message whether the name is unknown or the password is wrong,
    // so this screen cannot be used to find out who has an account here.
    const genericError = "That name and password don't match an account on this device.";

    if (!user) {
      error.textContent = genericError;
      return;
    }

    submit.disabled = true;
    try {
      const ok = await auth.verifyUser(user.id, password);
      submit.disabled = false;
      if (!ok) {
        error.textContent = genericError;
        $('#auth-password').select();
        return;
      }
      await adoptOwnerlessNodes(user.id);
      await enterApp(user);
    } catch (error_) {
      submit.disabled = false;
      error.textContent = error_.message || 'Could not unlock the drive.';
    }
  });

  // Clear a previous error as soon as the user starts correcting the input.
  ['#auth-password', '#auth-password2', '#auth-name'].forEach((selector) => {
    const field = $(selector);
    if (!field) return;
    field.addEventListener('input', () => {
      const error = $('#auth-error');
      if (error) error.textContent = '';
    });
  });
}

async function boot() {
  // Served by the Deluxe Drive server, the drive keeps its accounts and files
  // there. Served as plain files, /api/health is not there, this answers null,
  // and the browser's own storage is used exactly as before.
  try {
    await cloud.detect();
  } catch (error) {
    /* no server: the browser's own storage is used */
  }

  // Each step is named, so a failure says where it stopped instead of
  // surfacing the browser's unhelpful "Script error".
  let stage = 'opening the drive database';

  try {
    if (!cloud.isOnline()) await openDB();

    stage = 'reading the accounts on this device';
    if (!cloud.isOnline()) await auth.migrateLegacyAccount();
    auth.forgetSession();

    stage = 'setting up the account screen';
    bindAuthScreen();

    stage = 'showing the accounts';
    await initAuthScreen();
  } catch (error) {
    showBootFailure(stage, error);
  }
}

boot();
