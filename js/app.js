import { db, openDB } from './db.js';
import * as auth from './auth.js';
import { icon, escapeHtml, formatBytes, formatDate, formatDateTime, showDialog, toast } from './ui.js';
import { officeType, renderOfficePreview, renderDelimited, renderDocxFaithful } from './office.js';

// Bumped by hand with each deploy. It is printed on the lock screen so the
// running build can be read out loud, which separates "stale cached page"
// from "real bug" without guessing.
const BUILD = 'build 14';

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
const OUR_SCRIPTS = ['/js/app.js', '/js/db.js', '/js/auth.js', '/js/ui.js'];

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
        <p class="card-meta">${escapeHtml(meta)}</p>
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

  let quota = 0;
  if (navigator.storage && navigator.storage.estimate) {
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
    if (node.type === 'file') items.push({ action: 'download', label: 'Download', icon: 'download' });
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

  openPreview(node);
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

async function openPreview(node) {
  const modal = $('#preview');
  if (!modal) return;

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
    body.innerHTML = `<iframe class="preview-frame" src="${url}" title="${escapeHtml(node.name)}"></iframe>`;
  } else if (officeType(node.name)) {
    // Word documents are laid out properly by docx-preview (pages, tables,
    // images, fonts). Everything else is read from its XML by office.js.
    if (officeType(node.name) === 'docx') {
      const holder = document.createElement('div');
      holder.className = 'docx-holder';
      body.innerHTML = '';
      body.appendChild(holder);

      const laidOut = await renderDocxFaithful(blob, holder);
      if (laidOut) return;
    }

    try {
      body.innerHTML = await renderOfficePreview(node.name, blob);
    } catch (error) {
      console.warn('Could not read document', node.name, error);
      openLink.classList.add('hidden');
      body.innerHTML = `
        <div class="preview-fallback">
          ${icon(iconForKind(kind))}
          <p>This document could not be read in the browser.</p>
          <p class="muted">${escapeHtml(error && error.message ? error.message : 'Unknown error')}</p>
          <button class="btn primary" type="button" data-download="1">Download ${escapeHtml(node.name)}</button>
        </div>`;
      body.querySelector('[data-download]').addEventListener('click', () => downloadNode(node));
    }
  } else if (isTextual(kind, node.mime, node.name)) {
    try {
      const text = await readText(blob);
      const extension = String(node.name).toLowerCase().split('.').pop();
      if ((extension === 'csv' || extension === 'tsv') && text.length < 2000000) {
        body.innerHTML = renderDelimited(text, extension === 'tsv' ? '\t' : ',');
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
  toast(`Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`);

  let added = 0;
  let failed = 0;

  for (const file of files) {
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

async function resetDrive() {
  if (!state.currentUser) return;

  const sure = await showDialog({
    title: 'Erase my files?',
    message: `Every file and folder in ${state.currentUser.name}'s drive will be deleted from this device. The account and its password stay.`,
    confirmLabel: 'Erase my files',
    danger: true,
  });
  if (!sure) return;

  await deleteNodesOfUser(state.currentUser.id);
  await loadNodes();
  render();
  toast('Your drive is empty');
}

function lockDrive() {
  auth.forgetSession();
  location.reload();
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
        { action: 'lock', label: 'Lock drive', icon: 'logout' },
        { action: 'reset', label: 'Erase my files', icon: 'trash', danger: true },
      ],
      (action) => {
        if (action === 'password') changePasswordFlow();
        else if (action === 'lock') lockDrive();
        else if (action === 'reset') resetDrive();
      }
    );
  });

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
let authMode = 'pick'; // pick | unlock | create
let authUserId = null;

async function initAuthScreen() {
  const buildNode = $('#auth-build');
  if (buildNode) buildNode.textContent = BUILD;

  authUsers = await auth.listUsers();

  if (!authUsers.length) {
    authMode = 'create';
    authUserId = null;
  } else if (authUsers.length === 1) {
    authMode = 'unlock';
    authUserId = authUsers[0].id;
  } else {
    authMode = 'pick';
    authUserId = null;
  }

  renderAuthScreen();
}

function renderAuthScreen() {
  const list = $('#auth-users');
  const nameField = $('#name-field');
  const password2Field = $('#pw2-field');
  const submit = $('#auth-submit');
  const newButton = $('#auth-new');
  const resetButton = $('#auth-reset');
  const passwordLabel = $('#password-label');
  const sub = $('#auth-sub');

  const creating = authMode === 'create';
  const selected = authUsers.find((user) => user.id === authUserId) || null;

  list.innerHTML = authUsers
    .map(
      (user) => `
      <button class="user-chip${user.id === authUserId ? ' active' : ''}" type="button" data-user="${user.id}">
        <span class="user-chip-avatar">${escapeHtml(user.name.slice(0, 1).toUpperCase())}</span>
        <span class="user-chip-name">${escapeHtml(user.name)}</span>
      </button>`
    )
    .join('');
  list.classList.toggle('hidden', !authUsers.length || creating);

  nameField.classList.toggle('hidden', !creating);
  password2Field.classList.toggle('hidden', !creating);

  // While choosing between accounts there is no password to type yet.
  const picking = authMode === 'pick';
  $('#password-field').classList.toggle('hidden', picking);
  submit.classList.toggle('hidden', picking);

  passwordLabel.textContent = creating
    ? 'Choose a password'
    : selected
      ? `Password for ${selected.name}`
      : 'Password';

  submit.textContent = creating ? 'Create account' : 'Unlock';

  newButton.classList.toggle('hidden', creating && !authUsers.length);
  newButton.textContent = creating
    ? 'Back to accounts'
    : picking
      ? 'Create new account'
      : 'Use another account';

  resetButton.classList.toggle('hidden', creating || picking || !selected);
  resetButton.textContent = selected ? `Forgot password? Erase ${selected.name}'s drive` : 'Forgot password?';

  sub.textContent = creating
    ? 'Create an account on this device. Each account has its own password and its own files.'
    : selected
      ? 'Enter your password to open this drive.'
      : 'Choose an account, or create a new one.';

  $('#auth-password').value = '';
  $('#auth-password2').value = '';
  $('#auth-name').value = '';
  $('#auth-error').textContent = '';

  if (creating) $('#auth-name').focus();
  else $('#auth-password').focus();
}

function bindAuthScreen() {
  $('#auth-users').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-user]');
    if (!chip) return;
    authUserId = chip.dataset.user;
    authMode = 'unlock';
    renderAuthScreen();
  });

  $('#auth-new').addEventListener('click', () => {
    if (authMode === 'create') {
      if (authUsers.length === 1) {
        authMode = 'unlock';
        authUserId = authUsers[0].id;
      } else {
        authMode = 'pick';
        authUserId = null;
      }
    } else if (authMode === 'pick') {
      authMode = 'create';
      authUserId = null;
    } else {
      authMode = 'pick';
      authUserId = null;
    }
    renderAuthScreen();
  });

  $('#auth-reset').addEventListener('click', async () => {
    const user = authUsers.find((entry) => entry.id === authUserId);
    if (!user) return;

    const sure = await showDialog({
      title: `Erase ${user.name}'s drive?`,
      message:
        'This deletes that account and every file in it from this device. A forgotten password cannot be recovered.',
      confirmLabel: 'Erase account',
      danger: true,
    });
    if (!sure) return;

    await deleteNodesOfUser(user.id);
    await auth.removeUser(user.id);
    authUserId = null;
    await initAuthScreen();
    toast(`${user.name}'s drive was erased`);
  });

  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();

    const error = $('#auth-error');
    const submit = $('#auth-submit');
    const password = $('#auth-password').value;
    error.textContent = '';

    if (authMode === 'create') {
      const name = $('#auth-name').value.trim();
      const confirmPassword = $('#auth-password2').value;

      if (!name) {
        error.textContent = 'Give this account a name.';
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

    if (authMode === 'pick') {
      error.textContent = 'Choose an account above, or create a new one.';
      return;
    }

    const user = authUsers.find((entry) => entry.id === authUserId);
    if (!user) {
      error.textContent = 'Choose an account.';
      return;
    }

    submit.disabled = true;
    try {
      const ok = await auth.verifyUser(user.id, password);
      submit.disabled = false;
      if (!ok) {
        error.textContent = 'Wrong password. Try again.';
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
  // Each step is named, so a failure says where it stopped instead of
  // surfacing the browser's unhelpful "Script error".
  let stage = 'opening the drive database';

  try {
    await openDB();

    stage = 'reading the accounts on this device';
    await auth.migrateLegacyAccount();
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
