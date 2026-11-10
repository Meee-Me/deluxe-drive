# Deluxe Drive

A Google Drive–style file manager. It signs in with your **Deluxe account** from
[Deluxe Main](https://deluxe-main.deluxelordd.workers.dev): Deluxe Drive never makes accounts.

- **Deluxe Main** keeps the account and everything the drive saves about your files: the folder and
  file list (names, folders, stars, trash) and settings.
- **Deluxe Drive** (this server) keeps only the **file contents** and share links. It checks every
  request's key with Deluxe Main.

## What it does

- **Deluxe account** — the lock screen has one button, **Sign in with Deluxe Main**. Deluxe Main signs
  you in (or makes your account), and sends you straight back. The account menu has **Your Deluxe
  account** (name, password and deleting the account are managed on Deluxe Main) and **Sign out**.
  Accounts made in Deluxe Drive before Deluxe Main existed sign in on Deluxe Main with the same name
  and password: the account moves there, and the first visit moves its file list too. The files
  themselves never move.
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
- **Deluxe Docs** — Docs signs in with Deluxe Main too, and lists and opens your drive's files (read
  only). Opening a document here shares it and opens it in Deluxe Docs (turn this off under **Deluxe
  Docs** in the account menu); if that fails, it opens in the built-in preview.
- **More websites** — a button in the top bar (and a link on the lock screen) opens a list of the
  other Deluxe Lord sites: YouTube Guider AI, Deluxe Convert and Deluxe Translate.
- **Select mode** — select several items and download, star, move or delete them together, plus
  a details panel and next/previous navigation inside the preview.
- **Grid and list layouts**, sorting by name / last modified / size, storage usage meter, light and
  dark themes, drag-and-drop upload, right-click / long-press menus.

## Running it

The drive runs as a Cloudflare Worker on `*.workers.dev`: the page, plus the server for file contents
and share links.

```
index.html          markup for the lock screen and the app shell
styles.css          all styling, including dark mode and mobile drawer
js/app.js           app state, rendering, file actions, previews, uploads
js/cloud.js         sign-in with Deluxe Main; the file list in Main, file contents in the drive server
js/office.js        reads .docx / .xlsx / .pptx / .odt / .ods / .odp / .rtf in the browser
js/viewer.js        zoom controls, pinch / Ctrl+wheel, page box, and the all-pages PDF renderer
js/ui.js            icons, formatting, toasts, modal dialogs
vendor/             pinned docx-preview + JSZip (faithful .docx) and PDF.js (PDF pages) builds
worker/index.js     entry point: serves the page, sends /api and /s to the Hub
worker/hub.js       the server: file contents, share links, moving old accounts to Deluxe Main
wrangler.jsonc      bindings and settings (MAIN_URL: which Deluxe Main to trust)
tests/              node tests/worker.test.mjs   (runs the server code against fakes)
```

Set it up once:

1. **Deploy Deluxe Main first** (its own repository). Deluxe Drive asks it about every key.
2. **Deploy this.** Workers & Pages, your `deluxe-drive` Worker, Settings, Builds, connect this repository,
   deploy command `npx wrangler deploy`. Or run `npx wrangler deploy` yourself. `MAIN_URL` in
   `wrangler.jsonc` is the Deluxe Main address. Once both Workers are on the same account you can
   uncomment the `MAIN` service binding, which is a little faster.
3. **Optional, for a big drive: R2.** Files are cut into 1 MB pieces in the database, which suits personal
   use. To keep files in R2 instead, enable R2 in the dashboard, create a bucket, and uncomment the
   `r2_buckets` entry in `wrangler.jsonc` (binding `FILES`). Nothing else changes.

A single file can be up to 100 MB (the Workers request limit). Copies of the page hosted elsewhere
(Vercel) use the drive server on Cloudflare.

Tests: `node tests/worker.test.mjs` (SQLite) and `STORE=r2 node tests/worker.test.mjs` (fake R2).
To try it locally with a local Deluxe Main: in Deluxe-Main run
`ALLOW_LOCALHOST=1 DRIVE_URL=http://localhost:8787 node tests/dev-server.mjs 8790`, then here
`MAIN_URL=http://localhost:8790 node tests/dev-server.mjs 8787` and open http://localhost:8787.

## Deluxe Docs

Deluxe Docs (`https://deluxe-docs-iota.vercel.app`) signs in with Deluxe Main by itself: no link ID.
It reads the file list from Deluxe Main and the files from this server, with a key that can only read.
Opening a document in the drive hands it to Docs through a share link
(`…?url=<share link>&name=<file name>`); those links are listed under **Shared links** in the
account menu, where they can be copied again or stopped.

## Data notes

- File contents and share links are kept by this Worker (its database, or R2). Everything else, and
  the account itself, is kept by Deluxe Main.
- "Erase my files" in the account menu empties the drive but keeps the Deluxe account. Deleting the
  account on Deluxe Main also deletes its files here.

## Credits

Directed by **Shivad Sujith**. AI support: **Claude**. Built with **FreeMilk**. Powered by
**Netlify**. Other sites by Deluxe Lord — [Deluxe Main](https://deluxe-main.deluxelordd.workers.dev) (your Deluxe account), [YouTube Guider AI](https://youtube-guide-ai.netlify.app/),
[Deluxe Convert](https://deluxe-convert-cloud.deluxelordd.workers.dev),
[Deluxe Translate](https://deluxe-translate-8m27.netlify.app/). The same list is in the app: the
**credits** link on the lock screen, or **Credits** in the account menu.
