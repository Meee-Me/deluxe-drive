# Deluxe Drive

A Google Drive–style file manager that runs entirely in the browser. No server, no account with
Google: your files live in this browser's IndexedDB, behind a password you choose.

## What it does

- **Password lock** — on first run you create a password; it is never stored, only a salted
  PBKDF2-SHA256 hash (WebCrypto). "Keep me unlocked on this device" remembers the unlock in
  `localStorage`; changing the password invalidates that.
- **Folders and files** — upload any file type (single, multiple, whole folders), create folders,
  rename, move, star, delete to trash, restore, delete forever, empty trash.
- **Views** — My Drive with breadcrumbs, Recent, Starred, Trash, and full-name search.
- **Previews** — images, video, audio and PDF open inline; text, code, JSON, CSV and markdown are
  shown as text; anything else offers a download.
- **Grid and list layouts**, sorting by name / last modified / size, storage usage meter, light and
  dark themes, drag-and-drop upload, right-click / long-press menus.

## Running it

It is a static site: open `index.html` over http(s) — for example the preview link — and it works.
`file://` will not work because ES modules and WebCrypto need a proper origin.

```
index.html      markup for the lock screen and the app shell
styles.css      all styling, including dark mode and mobile drawer
js/app.js       app state, rendering, file actions, previews, uploads
js/db.js        IndexedDB layer (nodes / blobs / settings stores)
js/auth.js      password hashing, unlock session
js/ui.js        icons, formatting, toasts, modal dialogs
```

## Data notes

- Files are stored as Blobs in IndexedDB, so the browser's storage limit (often several GB) is the
  only cap. Each browser/device has its own drive; clearing site data erases it.
- "Erase everything" in the account menu wipes files and the password from this device.
- Because everything is client-side, the password protects the UI — someone with access to the
  device's developer tools could still read IndexedDB. It is not encryption at rest.

## Google Drive itself

Connecting the real Google Drive needs a Google Cloud OAuth client ID and secret and a server-side
token exchange; those credentials cannot be shipped inside a static page, so this app keeps its own
storage instead. If you later want real Drive sync, the place to add it is a small backend that
exposes "list files / upload / download" and swaps IndexedDB in `js/db.js` for those calls.
