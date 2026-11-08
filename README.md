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
- **Deluxe Docs** — *Connect Deluxe Docs* in the account menu has one button, **Generate link ID**:
  a 60-second, one-use code that is pasted into Deluxe Docs to connect it to this account (read
  only). Once connected, opening a document (Word, Excel, slides, PDF, text) shares it and opens it
  in Deluxe Docs; if that fails, it opens in the built-in preview.
- **Deluxe Convert** — *Connect Deluxe Convert* in the account menu works the same way: **Generate
  link ID**, then **Open Deluxe Convert**. From then on, every converted file in Deluxe Convert has
  **Share to Deluxe Drive**, which adds it to a **Deluxe Convert** folder here (and can make a share
  link for it). Convert's key can only add files. Coming back to the drive's tab shows new files.
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
js/cloud.js         the server client: accounts, storage, share links, Deluxe Docs and Convert
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

## On Vercel (the live drive)

The drive lives at **https://deluxe-drive-xi.vercel.app**. Vercel serves the page, and a Vercel Function
(`api/hub.mjs`) is its server: accounts, files, share links, and link IDs for Deluxe Docs and Deluxe
Convert. It runs the same server code as the Cloudflare Worker (`worker/hub.js`) and keeps everything in
**Postgres**, because a Vercel Function has no disk of its own.

Set it up once:

1. In Vercel, open the **deluxe-drive** project → **Storage** → **Create Database** → **Neon (Postgres)**
   (the free plan is enough) → connect it to the project for all environments. Vercel then sets
   `DATABASE_URL` (`POSTGRES_URL` also works).
2. **Redeploy** (Deployments → ⋯ → Redeploy), so the function sees the new variable.
3. Open https://deluxe-drive-xi.vercel.app/api/health. It should say `"ok":true`. The tables are made
   on first use.

Until a database is connected, `/api/health` answers that there is none, the page says so, and files
stay in the browser as before.

```
api/hub.mjs        the Vercel Function: /api/* and /s/* (vercel.json rewrites them here)
api/_pg.mjs        Postgres for the server code (? placeholders, BYTEA, BIGINT)
vercel.json        the rewrites, function settings and cache headers
.vercelignore      files that are not part of the Vercel site
tests/vercel-dev.mjs   DATABASE_URL=postgres://... node tests/vercel-dev.mjs  (a local stand-in)
```

A Vercel Function takes about 4.5 MB per request, so bigger files go up in 4 MB pieces
(`PUT /api/db/blobs/:id?offset=…&last=1`, and the same for `/api/import`). The page and Deluxe Convert
do this by themselves; a file can still be up to 100 MB. Files are kept in the database in 1 MB pieces,
so the database's size is the drive's size (0.5 GB on Neon's free plan).

Tests: `PG_URL=postgres://... node tests/worker.test.mjs` runs the server tests on Postgres.

## On Cloudflare (Workers)

The drive's server runs as a Cloudflare Worker on `*.workers.dev`: accounts, files, share links and
link IDs for Deluxe Docs.

```
worker/index.js    entry point: serves the page, sends /api and /s to the Hub
worker/hub.js      the server: accounts, files, share links, link IDs (Durable Object, SQLite or R2)
wrangler.jsonc     bindings and settings
.assetsignore      files that are not part of the public site
tests/             node tests/worker.test.mjs   (runs the server code against fakes)
```

Set it up once:

1. **Deploy.** Workers & Pages, your `deluxe-drive` Worker, Settings, Builds, connect this repository,
   deploy command `npx wrangler deploy`. Or run `npx wrangler deploy` yourself. Nothing else has to be
   created: accounts and files are kept in the Worker's own database, which works on a free account.
2. **Optional, for a big drive: R2.** Files are cut into 1 MB pieces in the database, which suits personal
   use. To keep files in R2 instead, enable R2 in the dashboard, create a bucket, and uncomment the
   `r2_buckets` entry in `wrangler.jsonc` (binding `FILES`). Nothing else changes.

Accounts and files survive deploys. A single file can be up to 100 MB (the Workers request limit). A key given to
Deluxe Docs can only read file lists and file contents.

Tests: `node tests/worker.test.mjs` (SQLite) and `STORE=r2 node tests/worker.test.mjs` (fake R2).

## Deluxe Docs

Deluxe Docs is a separate site (`https://deluxe-docs-iota.vercel.app`). To connect it:

1. In the drive (running with its server), open the account menu (the avatar) → **Connect Deluxe Docs**.
2. Press **Generate link ID**. A code like `62EJ-CBTD-V98W` appears and is copied.
3. Paste it into Deluxe Docs within 60 seconds. Docs sends it to the drive, the drive finds the account
   it belongs to, and Docs is connected: it lists that account's files and opens them.

A link ID is 12 letters and digits (no 0, O, 1 or I, so it reads cleanly), new every time, works once,
and runs out after 60 seconds. Making a new one ends the previous one, and the dialog makes a fresh one
when the shown one runs out. Docs gets a key that can **only read** the file list and the files (no
uploads, deletes, sharing or settings); it lasts 30 days, and **Disconnect** in Docs ends it. Wrong
guesses are slowed down per address.

## Deluxe Convert

Deluxe Convert (`https://deluxe-convert.vercel.app`) connects with a link ID too:
account menu → **Connect Deluxe Convert** → **Generate link ID** → **Open Deluxe Convert** (or type the
code into Convert's **Connect Deluxe Drive** box). Link IDs are made for one app: a Docs code does not
work in Convert, and a Convert code does not work in Docs. Making a new one only ends the earlier code
for the same app.

Convert posts the code to `/api/link/redeem` with `"app": "deluxe-convert"` and gets a key (30 days)
that may only call `POST /api/import` and `GET /api/auth/me`. `POST /api/import` takes the file as the
body, its name in `X-Deluxe-Name` (URI-encoded) and its type in `Content-Type`. The file is put in a
**Deluxe Convert** folder at the top of the drive (made if missing), with ` (1)`, ` (2)` … added when
the name is taken. `?share=1` also makes a share link and returns it.

After the first link ID, opening a document in the drive hands it to Deluxe Docs through a share link
(`…?url=<share link>&name=<file name>`). Those links are listed under **Shared links** in the account
menu, where they can be copied again or stopped.

The Node server in `server/` still has the older connection (a permanent link plus a sign-in page). The
Cloudflare Worker in `worker/` is the one with link IDs, and it is what the drive's page expects.

## Data notes

- **Without a server**, files are Blobs in IndexedDB: the browser's storage limit (often several
  GB) is the only cap, each browser/device has its own accounts, and clearing site data erases
  them all. The password protects the UI — someone with access to the device's developer tools
  could still read IndexedDB. It is not encryption at rest.
- **With the server**, accounts and files live under `DATA_DIR` (`/data` in the image). A single
  file may be up to `MAX_UPLOAD_BYTES` (256 MB by default) and the drive refuses a larger one
  before starting the upload. Sessions are kept in memory only, so a server restart
  asks everyone to sign in again. On Cloud Run the container's disk is fresh on every start, so
  mount a volume for `DATA_DIR` to keep files between runs.
- "Erase my files" in the account menu empties the signed-in account's drive but keeps its
  password; on the lock screen, "Forgot password?" erases a whole local account and its files. A
  server account can only be erased while signed in.

## Credits

Directed by **Shivad Sujith**. AI support: **Claude**. Built with **FreeMilk**. Powered by
**Netlify**. Other sites by Deluxe Lord — [YouTube Guider AI](https://youtube-guide-ai.netlify.app/),
[Deluxe Convert](https://deluxe-convert.vercel.app),
[Deluxe Translate](https://deluxe-translate-8m27.netlify.app/). The same list is in the app: the
**credits** link on the lock screen, or **Credits** in the account menu.
