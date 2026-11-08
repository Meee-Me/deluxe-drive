# Deluxe Drive

A Google Drive–style file manager. Opened as plain files, it runs entirely in the browser and
keeps your files in this browser's IndexedDB. Started with its own server, the same page keeps
the accounts and the files **on the server**, so the drive opens on every device and files can be
shared — and it can hand a document to **Deluxe Docs**.

## What it does

- **Accounts and passwords** — several people can use one drive without seeing each other. Each
  account's files are only ever loaded for that account. Only a salted PBKDF2-SHA256 hash is
  stored, never the password, and the password is asked for **every time** the page is opened.
  On the server, the browser hashes the password with the salt the server returns and only the
  hash travels; the server never sees the password itself.
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
- **Zoom and every page** — PDF, Word, PowerPoint, Excel (and OpenDocument / RTF / CSV) previews
  show **all** pages, slides or sheets in one scrolling view. Zoom 25%–400% with the − / + buttons,
  **Fit width**, `+` `-` `0` on the keyboard, Ctrl/⌘ + mouse wheel (or a trackpad pinch), or a
  two-finger pinch on a phone. A **Page / Slide / Sheet** box shows where you are and jumps to any
  number. PDFs are drawn by a bundled copy of PDF.js (rendered sharply at each zoom level); if it
  cannot load, the browser's own PDF viewer is used instead.
- **Sharing** — a file can be given a share link (`/s/<token>`) that needs no sign-in and serves
  that one file, with HTTP Range support so video and PDF seek. Shared files wear a link badge, and
  **Shared links** in the account menu lists every link with Copy and Stop. Deleting a file also
  removes its stored data and its link.
- **Deluxe Docs** — *Connect Deluxe Docs* in the account menu registers the documents app as an
  OAuth 2.0 + PKCE viewer of this drive (Authorization Code flow, consent page, `/oauth/token`,
  `/oauth/userinfo`). Once connected, opening a document (Word, Excel, slides, PDF, text) shares it
  and opens it in Deluxe Docs; if that fails or is switched off, it opens in the built-in preview.
  **Open Deluxe Docs** in the connection dialog reopens the viewer at any time.
- **More websites** — a button in the top bar (and a link on the lock screen) opens a list of the
  other Deluxe Lord sites: YouTube Guider AI, Deluxe Convert and Deluxe Translate.
- **Select mode** — select several items and download, star, move or delete them together, plus
  a details panel and next/previous navigation inside the preview.
- **Grid and list layouts**, sorting by name / last modified / size, storage usage meter, light and
  dark themes, drag-and-drop upload, right-click / long-press menus.

## Running it

**As plain files.** Open `index.html` over http(s) — for example the preview link — and it works.
`file://` will not work because ES modules and WebCrypto need a proper origin. Files stay in that
browser, and Deluxe Docs cannot connect (it needs the server). A copy served this way can still use
a server elsewhere: open the account menu → **Connect Deluxe Docs**, and enter its address under
**Deluxe Drive server** — every call is sent there from then on (the server answers CORS).

**With the server.** No dependencies to install: node's own `http`, `fs` and `crypto` do it.

```
node server/index.js          # listens on $PORT (8080) and 0.0.0.0
DATA_DIR=/data node server/index.js   # keep the files somewhere specific
```

The same command serves the page, so open `http://localhost:8080`. `Dockerfile` is the image for
that, which is how it is published: it starts the server with `node server/index.js`.

```
index.html          markup for the lock screen and the app shell
styles.css          all styling, including dark mode and mobile drawer
js/app.js           app state, rendering, file actions, previews, uploads
js/cloud.js         the server client: accounts, storage, share links, Deluxe Docs
js/office.js        reads .docx / .xlsx / .pptx / .odt / .ods / .odp / .rtf in the browser
js/viewer.js        zoom controls, pinch / Ctrl+wheel, page box, and the all-pages PDF renderer
vendor/             pinned docx-preview + JSZip (faithful .docx) and PDF.js (PDF pages) builds
js/db.js            IndexedDB layer (nodes / blobs / settings stores), used without a server
js/auth.js          password hashing, unlock session
js/ui.js            icons, formatting, toasts, modal dialogs
server/index.js     HTTP server: the drive, its API, share links, OAuth endpoints
server/store.js     accounts, files, share links and sessions on disk
server/oauth.js     Authorization Code + PKCE for Deluxe Docs
```

## On Cloudflare (Workers)

The Node server above is mirrored by a Cloudflare Worker, so the drive can run on
`*.workers.dev` with the same accounts, files, share links and Link ID.

```
worker/index.js    entry point: serves the page, sends /api /oauth /connect /s to the Hub
worker/hub.js      the server: accounts, files, share links, Link ID, OAuth (Durable Object, SQLite or R2)
worker/pages.js    the sign-in and consent pages Deluxe Docs is sent to
wrangler.jsonc     bindings and settings
.assetsignore      files that are not part of the public site
tests/             node tests/worker.test.mjs   (runs the server code against fakes)
```

Set it up once:

1. **Deploy.** Workers & Pages, your `deluxe-drive` Worker, Settings, Builds, connect this repository,
   deploy command `npx wrangler deploy`. Or run `npx wrangler deploy` yourself. Nothing else has to be
   created: accounts and files are kept in the Worker's own database, which works on a free account.
2. **Allow Deluxe Docs.** `ALLOWED_DOCS_ORIGINS` in `wrangler.jsonc` lists the Deluxe Docs addresses that
   may connect with a Link ID (comma separated). It already contains
   `https://deluxe-docs.deluxelordd.workers.dev`.
3. **Optional, for a big drive: R2.** Files are cut into 1 MB pieces in the database, which suits personal
   use. To keep files in R2 instead, enable R2 in the dashboard, create a bucket, and uncomment the
   `r2_buckets` entry in `wrangler.jsonc` (binding `FILES`). Nothing else changes.

Accounts and files survive deploys. A single file can be up to 100 MB (the Workers request limit). The
password check for Deluxe Docs happens in the sign-in page itself (the browser hashes the password, as the
drive does) because Workers cap PBKDF2 at 100,000 rounds. A token given to Deluxe Docs can only read file
lists and file contents.

Tests: `node tests/worker.test.mjs` (SQLite) and `STORE=r2 node tests/worker.test.mjs` (fake R2).

## Deluxe Docs

Deluxe Docs is a separate site. To connect it:

1. Start Deluxe Drive with its server (so `/api/health` answers) at an address **other sites can
   reach** — the preview link is private to you, so Deluxe Docs (which fetches the files from its
   own origin) cannot use it: publish the drive (Go Live) and use that link. A static copy of the
   drive can be pointed at such a server under **Deluxe Drive server** in the dialog below.
2. In the drive, open the account menu (the avatar) → **Connect Deluxe Docs**.
3. Paste the Deluxe Docs page address (`https://…`). The drive registers it as an OAuth client.
4. Every account gets its own **Link ID** the first time the drive opens on the server — shown under
   **Link for Deluxe Docs** in the account menu and in the Connect dialog, as
   `https://<drive>/connect/<id>`. Copy it into Deluxe Docs' **Connect to Deluxe Drive** box: the
   viewer reads it, registers its own page and signs in. One paste, no file to edit.
5. Open a document in the drive. The file is shared and Deluxe Docs is opened at
   `…?url=<share link>&name=<file name>` — `url` is the name Deluxe Docs reads, `name` sets the tab
   title.
6. Those links show up under **Shared links** in the account menu, where any of them can be copied
   again or stopped for everyone.

Sign-in for Deluxe Docs happens on Deluxe Drive's own pages, so the drive password is typed into
Deluxe Drive and never sent to Deluxe Docs. A viewer token can only read (scope
`profile drive.read`), and the drive asks which account and files to allow on the consent page.

## Data notes

- **Without a server**, files are Blobs in IndexedDB: the browser's storage limit (often several
  GB) is the only cap, each browser/device has its own accounts, and clearing site data erases
  them all. The password protects the UI — someone with access to the device's developer tools
  could still read IndexedDB. It is not encryption at rest.
- **With the server**, accounts and files live under `DATA_DIR` (`/data` in the image). A single
  file may be up to `MAX_UPLOAD_BYTES` (256 MB by default) and the drive refuses a larger one
  before starting the upload. Sessions and OAuth codes are kept in memory only, so a server restart
  asks everyone to sign in again. On Cloud Run the container's disk is fresh on every start, so
  mount a volume for `DATA_DIR` to keep files between runs.
- "Erase my files" in the account menu empties the signed-in account's drive but keeps its
  password; on the lock screen, "Forgot password?" erases a whole local account and its files. A
  server account can only be erased while signed in.

## Credits

Directed by **Shivad Sujith**. AI support: **Claude**. Built with **FreeMilk**. Powered by
**Netlify**. Other sites by Deluxe Lord — [YouTube Guider AI](https://youtube-guide-ai.netlify.app/),
[Deluxe Convert](https://deluxe-convert-cloud.deluxelordd.workers.dev),
[Deluxe Translate](https://deluxe-translate-8m27.netlify.app/). The same list is in the app: the
**credits** link on the lock screen, or **Credits** in the account menu.
