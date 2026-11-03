// Small shared UI helpers: icons, text formatting, toasts and modal dialogs.

const ICONS = {
  folder: '<path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>',
  file: '<path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>',
  doc: '<path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>',
  image: '<path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>',
  video: '<path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/>',
  audio: '<path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>',
  pdf: '<path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v3zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5zM9 9.5h1v-1H9v1zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm11 5.5h1v-3h-1v3z"/>',
  sheet: '<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V9h14v10z"/>',
  slides: '<path d="M21 3H3c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h7v2H8v2h8v-2h-2v-2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/>',
  zip: '<path d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/>',
  code: '<path d="M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0 4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/>',
  text: '<path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z"/>',
  download: '<path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>',
  upload: '<path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/>',
  search: '<path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/>',
  close: '<path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>',
  more: '<path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>',
  menu: '<path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/>',
  star: '<path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>',
  'star-off': '<path d="M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z"/>',
  trash: '<path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>',
  restore: '<path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9z"/>',
  edit: '<path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>',
  grid: '<path d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z"/>',
  list: '<path d="M3 5h18v2H3V5zm0 6h18v2H3v-2zm0 6h18v2H3v-2z"/>',
  drive: '<path d="M8.4 2.6 1 15.4h7.1l7.4-12.8z"/><path d="M22.9 15.4 19.3 9H8.1l3.6 6.4z"/><path d="M1 15.4 4.6 21.6h14.8l3.5-6.2z"/>',
  lock: '<path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM9 8V6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9z"/>',
  logout: '<path d="M10 17l5-5-5-5v3H2v4h8v3zm9-14H5c-1.1 0-2 .9-2 2v3h2V5h14v14H5v-3H3v3c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/>',
  sun: '<path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0-5h-1v3h2V2h-1zm0 17h-1v3h2v-3h-1zM2 11h3v2H2v-2zm17 0h3v2h-3v-2zM4.9 3.5 3.5 4.9l2.1 2.1 1.4-1.4-2.1-2.1zm13.6 13.6-1.4 1.4 2.1 2.1 1.4-1.4-2.1-2.1zM19.1 3.5l-2.1 2.1 1.4 1.4 2.1-2.1-1.4-1.4zM6.5 18.1l-2.1 2.1 1.4 1.4 2.1-2.1-1.4-1.4z"/>',
  moon: '<path d="M12.3 2a9.9 9.9 0 0 0-1 19.7 10 10 0 0 1 1-19.7z"/>',
  plus: '<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>',
  'folder-open': '<path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/>',
};

export function icon(name, className = '') {
  const path = ICONS[name] || ICONS.file;
  return `<svg class="ico${className ? ` ${className}` : ''}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${path}</svg>`;
}

export function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (character) => {
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

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** index;
  const rounded = scaled >= 10 || index === 0 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
  return `${rounded} ${units[index]}`;
}

const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export function formatDate(timestamp) {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return timeFormat.format(date);
  return dayFormat.format(date);
}

export function toast(message) {
  const root = document.getElementById('toasts');
  if (!root) return;
  const element = document.createElement('div');
  element.className = 'toast';
  element.textContent = message;
  root.appendChild(element);
  setTimeout(() => element.classList.add('out'), 2600);
  setTimeout(() => element.remove(), 3200);
}

export function showDialog(options = {}) {
  const opts = {
    title: '',
    message: '',
    input: null,
    confirmLabel: 'OK',
    cancelLabel: 'Cancel',
    danger: false,
    ...options,
  };

  return new Promise((resolve) => {
    const root = document.getElementById('dialog');
    if (!root) {
      resolve(null);
      return;
    }

    root.innerHTML = `
      <div class="dialog-backdrop" data-close="1"></div>
      <div class="dialog" role="dialog" aria-modal="true">
        <h2>${escapeHtml(opts.title)}</h2>
        ${opts.message ? `<p class="dialog-msg">${escapeHtml(opts.message)}</p>` : ''}
        ${opts.input !== null ? `<input class="dialog-input" id="dialog-input" value="${escapeHtml(opts.input)}" />` : ''}
        <div class="dialog-actions">
          ${opts.cancelLabel ? `<button class="btn ghost" type="button" data-action="cancel">${escapeHtml(opts.cancelLabel)}</button>` : ''}
          <button class="btn ${opts.danger ? 'danger' : 'primary'}" type="button" data-action="ok">${escapeHtml(opts.confirmLabel)}</button>
        </div>
      </div>`;
    root.classList.remove('hidden');

    const input = root.querySelector('#dialog-input');
    const okButton = root.querySelector('[data-action="ok"]');

    const close = (value) => {
      document.removeEventListener('keydown', onKey, true);
      root.classList.add('hidden');
      root.innerHTML = '';
      resolve(value);
    };

    const submit = () => close(input ? input.value.trim() || null : true);

    function onKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(null);
      } else if (event.key === 'Enter' && input) {
        event.preventDefault();
        submit();
      }
    }

    document.addEventListener('keydown', onKey, true);

    const backdrop = root.querySelector('[data-close]');
    if (backdrop) backdrop.addEventListener('click', () => close(null));

    const cancelButton = root.querySelector('[data-action="cancel"]');
    if (cancelButton) cancelButton.addEventListener('click', () => close(null));

    okButton.addEventListener('click', submit);

    if (input) {
      input.focus();
      input.select();
    } else {
      okButton.focus();
    }
  });
}
