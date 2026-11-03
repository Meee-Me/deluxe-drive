import { db, openDB } from './db.js';
import * as auth from './auth.js';
import { icon, escapeHtml, formatBytes, formatDate, showDialog, toast } from './ui.js';

// Tells the guard in index.html that the app really started, so a working
// app never shows its "did not start" panel.
window.__deluxeDriveStarted = true;

// The guard panel in index.html may have appeared while a slow network was
// still loading this file; hide it now that the app is alive.
const bootFallback = document.getElementById('boot-fallback');
if (bootFallback) bootFallback.classList.add('hidden');

/* ------------------------------------------------------------------ */
/* Crash reporting: never fail silently                               */
/* ------------------------------------------------------------------ */

function reportCrash(message) {
  console.error('Deluxe Drive error:', message);

  const app = document.getElementById('app');
  const unlocked = app && !app.classList.contains('hidden');

  if (unlocked) {
    toast(`Something went wrong: ${message}`);
    return;
  }

  const box = document.getElementById('boot-fallback');
  const text = document.getElementById('boot-fallback-text');
  const detail = document.getElementById('boot-fallback-detail');
  if (box && text) {
    text.textContent = 'Deluxe Drive hit an error while starting.';
    if (detail) detail.textContent = message;
    box.classList.remove('hidden');
  }
}

window.addEventListener('error', (event) => {
  reportCrash((event && event.message) || 'Unknown script error');
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event && event.reason;
  reportCrash(reason && reason.message ? reason.message : String(reason || 'Unknown error'));
});

const $ = (selector) => document.querySelector(selector);

const state = {
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
  state.nodes = new Map(all.map((node) => [node.id, node]));
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

function cardHtml(node) {
  const isFolder = node.type === 'folder';
  const kind = isFolder ? 'folder' : fileKind(node.mime, node.name);
  const star = node.starred ? `<span class="star-badge">${icon('star')}</span>` : '';

  let meta;
  if (state.view === 'trash') {
    meta = `Deleted ${formatDate(node.trashedAt)}`;
  } else if (state.view === 'search' || state.view === 'starred') {
    meta = isFolder ? 'Folder' : `${formatBytes(node.size)} · ${formatDate(node.updatedAt)}`;
  } else if (isFolder) {
    meta = 'Folder';
  } else {
    meta = `${formatBytes(node.size)} · ${formatDate(node.updatedAt)}`;
  }

  return `
    <div class="card" data-id="${node.id}" tabindex="0" role="button" aria-label="${escapeHtml(node.name)}">
      <div class="card-thumb ${kind}" data-thumb="${node.id}">${icon(iconForKind(kind))}</div>
      <div class="card-body">
        <p class="card-name" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</p>
        <p class="card-meta">${escapeHtml(meta)}</p>
      </div>
      ${star}
      <button class="card-menu" type="button" data-menu="${node.id}" aria-label="More actions for ${escapeHtml(node.name)}">${icon('more')}</button>
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
  const grid = $('#file-grid');
  grid.className = state.layout === 'list' ? 'file-list' : 'file-grid';
  grid.innerHTML = items.map(cardHtml).join('');

  renderEmpty(items);
  $('#view-toggle').innerHTML = icon(state.layout === 'grid' ? 'list' : 'grid');
  $('#sort-select').value = state.sort;

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

async function deleteForever(node) {
  const ids = new Set([node.id, ...descendantIds(node.id)]);
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

  if (state.view === 'trash') {
    toast('Restore this item to open it');
    return;
  }

  if (node.type === 'folder') {
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
  } else if (isTextual(kind, node.mime, node.name)) {
    try {
      const text = await readText(blob);
      body.innerHTML = `<pre class="preview-text">${escapeHtml(text)}</pre>`;
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

/* ------------------------------------------------------------------ */
/* Uploads                                                             */
/* ------------------------------------------------------------------ */

async function saveFile(file, parentId) {
  const id = uid();
  await db.putBlob(id, file);
  const now = Date.now();
  const node = {
    id,
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
  const files = Array.from(fileList || []);
  if (!files.length) return;

  const targetParent = state.view === 'drive' ? state.folderId : null;
  toast(`Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`);

  let count = 0;
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
      count += 1;
    } catch (error) {
      console.error('Upload failed', file.name, error);
    }
  }

  render();
  toast(`${count} file${count === 1 ? '' : 's'} uploaded`);
}

async function createFolderFlow() {
  const parentId = state.view === 'drive' ? state.folderId : null;
  const name = await showDialog({ title: 'New folder', input: 'Untitled folder', confirmLabel: 'Create' });
  if (!name) return;

  const now = Date.now();
  const node = {
    id: uid(),
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
    valid = await auth.verify(current);
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

  await auth.changePassword(current, next);
  toast('Password updated');
}

async function resetDrive() {
  const sure = await showDialog({
    title: 'Erase everything?',
    message: 'Every file, folder and the password stored on this device will be deleted. This cannot be undone.',
    confirmLabel: 'Erase drive',
    danger: true,
  });
  if (!sure) return;

  await db.clearAll();
  auth.forget();
  await auth.destroyAccount();
  location.reload();
}

function lockDrive() {
  auth.forget();
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
    const files = event.target.files;
    event.target.value = '';
    await handleUpload(files);
  });

  $('#folder-input').addEventListener('change', async (event) => {
    const files = event.target.files;
    event.target.value = '';
    await handleUpload(files);
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
        { action: 'reset', label: 'Erase everything', icon: 'trash', danger: true },
      ],
      (action) => {
        if (action === 'password') changePasswordFlow();
        else if (action === 'lock') lockDrive();
        else if (action === 'reset') resetDrive();
      }
    );
  });

  $('#empty-trash').addEventListener('click', emptyTrash);

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
      document.body.classList.remove('sidebar-open');
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

async function enterApp() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');

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

async function initAuthScreen() {
  const exists = await auth.hasAccount();

  $('#auth-sub').textContent = exists
    ? 'Enter your password to unlock your drive.'
    : 'Set a password to protect this drive. Everything stays on this device.';
  $('#pw2-field').classList.toggle('hidden', exists);
  $('#auth-submit').textContent = exists ? 'Unlock' : 'Create drive';
  $('#auth-reset').classList.toggle('hidden', !exists);
  if (exists) $('#auth-remember').checked = auth.wasRemembered();

  $('#auth-password').focus();
}

function bindAuthScreen() {
  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();

    const password = $('#auth-password').value;
    const error = $('#auth-error');
    const submit = $('#auth-submit');
    const remember = $('#auth-remember').checked;
    $('#auth-error').textContent = '';

    let exists = false;
    try {
      exists = await auth.hasAccount();
    } catch (error_) {
      $('#auth-error').textContent = error_.message;
      return;
    }

    if (!exists) {
      const confirmPassword = $('#auth-password2').value;
      if (password.length < 4) {
        $('#auth-error').textContent = 'Use at least 4 characters.';
        return;
      }
      if (password !== confirmPassword) {
        $('#auth-error').textContent = 'Passwords do not match.';
        return;
      }
      submit.disabled = true;
      try {
        await auth.createAccount(password);
        await auth.remember(remember);
        submit.disabled = false;
        await enterApp();
        toast('Drive created and unlocked');
      } catch (error_) {
        submit.disabled = false;
        $('#auth-error').textContent = error_.message || 'Could not create the drive.';
      }
      return;
    }

    submit.disabled = true;
    try {
      const ok = await auth.verify(password);
      submit.disabled = false;
      if (!ok) {
        $('#auth-error').textContent = 'Wrong password. Try again.';
        $('#auth-password').select();
        return;
      }
      await auth.remember(remember);
      await enterApp();
    } catch (error_) {
      submit.disabled = false;
      $('#auth-error').textContent = error_.message || 'Could not unlock the drive.';
    }
  });

  $('#auth-reset').addEventListener('click', resetDrive);

  // Clear a previous error as soon as the user starts correcting the input,
  // so an old "Passwords do not match" never sits there while typing.
  ['#auth-password', '#auth-password2'].forEach((selector) => {
    const field = $(selector);
    if (!field) return;
    field.addEventListener('input', () => {
      const error = $('#auth-error');
      if (error) error.textContent = '';
    });
  });
}

async function boot() {
  try {
    await openDB();
  } catch (error) {
    document.body.innerHTML = `<div class="boot-error"><h1>Deluxe Drive</h1><p>${escapeHtml(
      error.message || 'Could not open the drive database.'
    )}</p></div>`;
    return;
  }

  bindAuthScreen();

  try {
    if (await auth.tryRestore()) {
      await enterApp();
      return;
    }
  } catch (_) {
    /* fall through to the lock screen */
  }

  await initAuthScreen();
}

boot();
