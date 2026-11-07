# Vendored libraries

These are third-party builds checked in so the app stays a plain static site
with no build step and no CDN dependency at runtime.

| File | Library | Version | Licence |
| --- | --- | --- | --- |
| `jszip.min.js` | [JSZip](https://github.com/Stuk/jszip) | 3.10.1 | MIT (dual-licensed MIT or GPLv3; used here under MIT) |
| `docx-preview.min.js` | [docx-preview](https://github.com/VolodymyrBaydalka/docxjs) | 0.3.7 | Apache License 2.0 |
| `pdfjs/pdf.min.mjs`, `pdfjs/pdf.worker.min.mjs` | [PDF.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist` legacy build) | 6.2.108 | Apache License 2.0 (see `pdfjs/LICENSE`) |

`docx-preview` renders `.docx` files as laid-out HTML (pages, tables, images,
fonts, headings) instead of extracted text. It needs JSZip, which the module
loads first. Both are fetched lazily, only when a Word document is opened, so
the drive itself still loads as a small app.

The licence texts live with the upstream projects; the copyright notices are
kept in the files' own header comments.

`pdfjs` draws every page of a PDF onto canvases so the whole file can be scrolled and
zoomed. It is imported lazily, only when a PDF is opened.
