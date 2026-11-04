# Deluxe Drive

A Google Drive–style file manager that runs entirely in the browser. No server, no account with
Google: your files live in this browser's IndexedDB, behind a password you choose.

## What it does

- **Accounts and passwords** — several people can use the same browser without seeing each other.
  The lock screen offers only the account last used **in that browser** (by name, with "Not you?" to
  start fresh); there is no list of everyone, so nobody can find out who else has a drive on the
  device. Each account's files are only ever loaded for that account. Only a salted
  PBKDF2-SHA256 hash is stored, never the password, and the password is asked for **every time**
  the page is opened — nothing is remembered between visits but the name.
- **Folders and files** — upload any file type (single, multiple, whole folders), create folders,
  rename, move, star, delete to trash, restore, delete forever, empty trash.
- **Views** — My Drive with breadcrumbs, Recent, Starred, Trash, and full-name search.
- **Previews** — images, video, audio and PDF open inline (PDF exactly, since the browser draws
  it). Word (`.docx`) is laid out as real pages with the vendored `docx-preview` library — tables,
  images, headings and fonts intact; Excel (`.xlsx`), OpenDocument (`.odt`, `.ods`, `.odp`) and
  Rich Text (`.rtf`) are read in the browser, spreadsheets with column letters, row numbers and
  sticky headers; PowerPoint (`.pptx`) is drawn from its own slide XML — positioned text boxes with
  the deck's font sizes and colours, images, solid fills and tables, on a canvas at the deck's exact
  aspect ratio; CSV/TSV open as tables; plain text and code are shown as text. Anything else offers
  a download.
- **Select mode** — select several items and download, star, move or delete them together, plus
  a details panel and next/previous navigation inside the preview.
- **Grid and list layouts**, sorting by name / last modified / size, storage usage meter, light and
  dark themes, drag-and-drop upload, right-click / long-press menus.

## Running it

It is a static site: open `index.html` over http(s) — for example the preview link — and it works.
`file://` will not work because ES modules and WebCrypto need a proper origin.

```
index.html      markup for the lock screen and the app shell
styles.css      all styling, including dark mode and mobile drawer
js/app.js       app state, rendering, file actions, previews, uploads
js/office.js    reads .docx / .xlsx / .pptx / .odt / .ods / .odp / .rtf in the browser
vendor/         pinned docx-preview + JSZip builds used for faithful .docx layout
js/db.js        IndexedDB layer (nodes / blobs / settings stores)
js/auth.js      password hashing, unlock session
js/ui.js        icons, formatting, toasts, modal dialogs
```

## Data notes

- Files are stored as Blobs in IndexedDB, so the browser's storage limit (often several GB) is the
  only cap. Every file carries the account that owns it; each browser/device has its own set of
  accounts; clearing site data erases them all.
- "Erase my files" in the account menu empties the signed-in account's drive but keeps its
  password; on the lock screen, "Forgot password?" erases a whole account and its files.
- Because everything is client-side, the password protects the UI — someone with access to the
  device's developer tools could still read IndexedDB. It is not encryption at rest.

## Google Drive itself

Connecting the real Google Drive needs a Google Cloud OAuth client ID and secret and a server-side
token exchange; those credentials cannot be shipped inside a static page, so this app keeps its own
storage instead. If you later want real Drive sync, the place to add it is a small backend that
exposes "list files / upload / download" and swaps IndexedDB in `js/db.js` for those calls.
