// Reads Office documents in the browser.
//
// .docx, .xlsx and .pptx (and .odt/.ods/.odp) are ZIP archives of XML, so no
// library is needed: this module unpacks the archive with a small ZIP reader
// and the platform's DecompressionStream, then pulls the text out of the XML.
// Everything here returns ready-made HTML; app.js only drops it into the
// preview panel.

const MAX_ENTRY_BYTES = 40 * 1024 * 1024; // refuse absurdly large parts
const MAX_ROWS = 300;
const MAX_COLUMNS = 40;
const MAX_PARAGRAPHS = 800;
const MAX_SLIDES = 150;
const MAX_CELL_CHARS = 2000;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function escapeHtml(value) {
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

function extensionOf(name) {
  return String(name || '').toLowerCase().split('.').pop();
}

function u16(view, offset) {
  return view.getUint16(offset, true);
}

function u32(view, offset) {
  return view.getUint32(offset, true);
}

/* ------------------------------------------------------------------ */
/* ZIP reading                                                         */
/* ------------------------------------------------------------------ */

function findEndOfCentralDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const first = Math.max(0, bytes.length - 0xffff - 22);
  for (let offset = bytes.length - 22; offset >= first; offset -= 1) {
    if (u32(view, offset) === 0x06054b50) return offset;
  }
  return -1;
}

async function inflateRaw(data) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot unpack Office files');
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function openArchive(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndOfCentralDirectory(bytes);
  if (end < 0) throw new Error('This file is not a ZIP archive');

  const count = u16(view, end + 10);
  let offset = u32(view, end + 16);
  const entries = new Map();

  for (let index = 0; index < count; index += 1) {
    if (u32(view, offset) !== 0x02014b50) break;
    const method = u16(view, offset + 10);
    const compressedSize = u32(view, offset + 20);
    const uncompressedSize = u32(view, offset + 24);
    const nameLength = u16(view, offset + 28);
    const extraLength = u16(view, offset + 30);
    const commentLength = u16(view, offset + 32);
    const localOffset = u32(view, offset + 42);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return { bytes, view, entries };
}

async function readEntry(archive, name) {
  const entry = archive.entries.get(name);
  if (!entry) return null;

  const { bytes, view } = archive;
  if (u32(view, entry.localOffset) !== 0x04034b50) throw new Error('Damaged archive');

  const nameLength = u16(view, entry.localOffset + 26);
  const extraLength = u16(view, entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const data = bytes.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new Error('Unsupported compression inside this file');
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new Error('This part of the file is too large to preview');
  return inflateRaw(data);
}

function parseXml(bytes) {
  const text = new TextDecoder().decode(bytes);
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('The document XML could not be read');
  return doc;
}

function collectText(parent, tagName) {
  const nodes = parent.getElementsByTagName(tagName);
  let text = '';
  for (let index = 0; index < nodes.length; index += 1) {
    text += nodes[index].textContent || '';
  }
  return text;
}

/* ------------------------------------------------------------------ */
/* Word (.docx / .odt)                                                 */
/* ------------------------------------------------------------------ */

function renderParagraphs(paragraphs, className) {
  const body = paragraphs
    .map((text) => (text ? `<p>${escapeHtml(text)}</p>` : '<p class="office-gap"></p>'))
    .join('');
  return `<div class="preview-doc"><div class="office-doc ${className}">${
    body || '<p class="muted">This document has no readable text.</p>'
  }</div></div>`;
}

async function readDocx(archive) {
  const bytes = await readEntry(archive, 'word/document.xml');
  if (!bytes) throw new Error('No document text found inside this file');

  const doc = parseXml(bytes);
  const nodes = doc.getElementsByTagName('w:p');
  const paragraphs = [];

  for (let index = 0; index < nodes.length && paragraphs.length < MAX_PARAGRAPHS; index += 1) {
    const text = collectText(nodes[index], 'w:t').replace(/\s+/g, ' ').trim();
    paragraphs.push(text);
  }

  return renderParagraphs(paragraphs, 'office-docx');
}

/* ------------------------------------------------------------------ */
/* Excel (.xlsx / .ods)                                                */
/* ------------------------------------------------------------------ */

function columnIndex(reference) {
  const letters = String(reference || '').replace(/[^A-Za-z]/g, '').toUpperCase();
  let value = 0;
  for (let index = 0; index < letters.length; index += 1) {
    value = value * 26 + (letters.charCodeAt(index) - 64);
  }
  return Math.max(0, value - 1);
}

function trimRow(cells) {
  let last = cells.length - 1;
  while (last >= 0 && !cells[last]) last -= 1;
  return cells.slice(0, last + 1);
}

function renderGrid(sheetName, rows) {
  const trimmed = rows.map(trimRow).filter((cells) => cells.length > 0);
  const heading = sheetName ? `<h3 class="office-sheet-name">${escapeHtml(sheetName)}</h3>` : '';

  if (!trimmed.length) {
    return `<div class="office-sheet">${heading}<p class="muted">This sheet is empty.</p></div>`;
  }

  const body = trimmed
    .map((cells) => {
      const tds = [];
      for (let column = 0; column < MAX_COLUMNS; column += 1) {
        const value = cells[column] === undefined ? '' : String(cells[column]).slice(0, MAX_CELL_CHARS);
        tds.push(`<td>${escapeHtml(value)}</td>`);
      }
      return `<tr>${tds.join('')}</tr>`;
    })
    .join('');

  return `<div class="office-sheet">
      ${heading}
      <div class="office-scroll">
        <table class="office-table"><tbody>${body}</tbody></table>
      </div>
    </div>`;
}

async function readSharedStrings(archive) {
  const bytes = await readEntry(archive, 'xl/sharedStrings.xml');
  if (!bytes) return [];
  const doc = parseXml(bytes);
  const items = doc.getElementsByTagName('si');
  const out = [];
  for (let index = 0; index < items.length; index += 1) {
    out.push(collectText(items[index], 't'));
  }
  return out;
}

async function readSheetNames(archive) {
  const bytes = await readEntry(archive, 'xl/workbook.xml');
  if (!bytes) return [];
  const doc = parseXml(bytes);
  const sheets = doc.getElementsByTagName('sheet');
  const names = [];
  for (let index = 0; index < sheets.length; index += 1) {
    names.push(sheets[index].getAttribute('name') || `Sheet ${index + 1}`);
  }
  return names;
}

function worksheetPaths(archive) {
  const found = [];
  archive.entries.forEach((entry) => {
    const match = /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(entry.name);
    if (match) found.push({ path: entry.name, index: Number(match[1]) });
  });
  found.sort((a, b) => a.index - b.index);
  return found.map((item) => item.path);
}

async function readWorksheet(archive, path, shared) {
  const bytes = await readEntry(archive, path);
  if (!bytes) return [];

  const doc = parseXml(bytes);
  const rowNodes = doc.getElementsByTagName('row');
  const rows = [];

  for (let rowIndex = 0; rowIndex < rowNodes.length && rows.length < MAX_ROWS; rowIndex += 1) {
    const cells = [];
    const cellNodes = rowNodes[rowIndex].getElementsByTagName('c');

    for (let cellIndex = 0; cellIndex < cellNodes.length && cellIndex < MAX_COLUMNS; cellIndex += 1) {
      const cell = cellNodes[cellIndex];
      const column = columnIndex(cell.getAttribute('r'));
      const type = cell.getAttribute('t');
      let value = '';

      if (type === 'inlineStr') {
        value = collectText(cell, 't');
      } else {
        const valueNode = cell.getElementsByTagName('v')[0];
        const raw = valueNode ? valueNode.textContent || '' : '';
        if (type === 's') value = shared[Number(raw)] || '';
        else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else value = raw;
      }

      cells[column] = value;
    }

    rows.push(cells);
  }

  return rows;
}

async function renderWorkbook(archive) {
  const shared = await readSharedStrings(archive);
  const names = await readSheetNames(archive);
  const paths = worksheetPaths(archive);

  if (!paths.length) throw new Error('No sheets found inside this file');

  const parts = [];
  for (let index = 0; index < paths.length && index < 12; index += 1) {
    const rows = await readWorksheet(archive, paths[index], shared);
    parts.push(renderGrid(names[index] || `Sheet ${index + 1}`, rows));
  }

  return `<div class="preview-doc office-stack">${parts.join('')}</div>`;
}

/* ------------------------------------------------------------------ */
/* PowerPoint (.pptx / .odp)                                           */
/* ------------------------------------------------------------------ */

function renderSlides(slides) {
  if (!slides.length) {
    return '<div class="preview-doc"><div class="office-doc"><p class="muted">This presentation has no readable text.</p></div></div>';
  }

  const html = slides
    .map(
      (slide) => `<section class="office-slide">
        <h3>Slide ${slide.number}</h3>
        ${slide.paragraphs
          .map((text) => (text ? `<p>${escapeHtml(text)}</p>` : ''))
          .join('')}
      </section>`
    )
    .join('');

  return `<div class="preview-doc office-stack">${html}</div>`;
}

async function readPptx(archive) {
  const found = [];
  archive.entries.forEach((entry) => {
    const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(entry.name);
    if (match) found.push({ path: entry.name, index: Number(match[1]) });
  });
  found.sort((a, b) => a.index - b.index);

  const slides = [];
  for (const item of found.slice(0, MAX_SLIDES)) {
    const bytes = await readEntry(archive, item.path);
    if (!bytes) continue;

    const doc = parseXml(bytes);
    const paragraphs = [];
    const nodes = doc.getElementsByTagName('a:p');
    for (let index = 0; index < nodes.length; index += 1) {
      const text = collectText(nodes[index], 'a:t').replace(/\s+/g, ' ').trim();
      if (text) paragraphs.push(text);
    }

    slides.push({ number: item.index, paragraphs });
  }

  return renderSlides(slides);
}

/* ------------------------------------------------------------------ */
/* OpenDocument (.odt / .ods / .odp)                                   */
/* ------------------------------------------------------------------ */

async function renderOpenDocument(archive, type) {
  const bytes = await readEntry(archive, 'content.xml');
  if (!bytes) throw new Error('No content found inside this file');

  const doc = parseXml(bytes);

  if (type === 'odt') {
    const nodes = doc.getElementsByTagName('text:p');
    const paragraphs = [];
    for (let index = 0; index < nodes.length && paragraphs.length < MAX_PARAGRAPHS; index += 1) {
      const text = (nodes[index].textContent || '').replace(/\s+/g, ' ').trim();
      paragraphs.push(text);
    }
    return renderParagraphs(paragraphs, 'office-odt');
  }

  if (type === 'ods') {
    const tables = doc.getElementsByTagName('table:table');
    const parts = [];
    for (let tableIndex = 0; tableIndex < tables.length && tableIndex < 12; tableIndex += 1) {
      const rows = [];
      const rowNodes = tables[tableIndex].getElementsByTagName('table:table-row');
      for (let rowIndex = 0; rowIndex < rowNodes.length && rows.length < MAX_ROWS; rowIndex += 1) {
        const cells = [];
        const cellNodes = rowNodes[rowIndex].getElementsByTagName('table:table-cell');
        for (let cellIndex = 0; cellIndex < cellNodes.length && cells.length < MAX_COLUMNS; cellIndex += 1) {
          const cell = cellNodes[cellIndex];
          const repeat = Number(cell.getAttribute('table:number-columns-repeated') || 1);
          const value = (cell.textContent || '').replace(/\s+/g, ' ').trim();
          for (let copy = 0; copy < Math.min(repeat, MAX_COLUMNS); copy += 1) cells.push(value);
        }
        rows.push(cells);
      }
      parts.push(renderGrid(tables[tableIndex].getAttribute('table:name') || `Sheet ${tableIndex + 1}`, rows));
    }
    return `<div class="preview-doc office-stack">${parts.join('')}</div>`;
  }

  // odp
  const pages = doc.getElementsByTagName('draw:page');
  const slides = [];
  for (let index = 0; index < pages.length && slides.length < MAX_SLIDES; index += 1) {
    const paragraphs = [];
    const nodes = pages[index].getElementsByTagName('text:p');
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
      const text = (nodes[nodeIndex].textContent || '').replace(/\s+/g, ' ').trim();
      if (text) paragraphs.push(text);
    }
    slides.push({ number: index + 1, paragraphs });
  }
  return renderSlides(slides);
}

/* ------------------------------------------------------------------ */
/* Plain text formats                                                  */
/* ------------------------------------------------------------------ */

export function renderDelimited(text, delimiter) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n').slice(0, MAX_ROWS);
  const rows = lines.map((line) => line.split(delimiter).map((cell) => cell.trim()));
  return `<div class="preview-doc">${renderGrid('', rows)}</div>`;
}

export function renderRtf(text) {
  const source = String(text);

  // Drop font/colour tables and other groups that carry no text.
  const stripped = source
    .replace(/\\\*[a-zA-Z]+[^{}]*/g, ' ')
    .replace(/\{\\\*[^{}]*\}/g, ' ')
    .replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
    .replace(/[{}]/g, '');

  const paragraphs = stripped
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_PARAGRAPHS);

  return renderParagraphs(paragraphs, 'office-rtf');
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

// Which reader, if any, can open this file. Returns '' when it is not a
// document this module understands (it then falls back to a download).
export function officeType(name) {
  const extension = extensionOf(name);

  if (['docx', 'docm', 'dotx', 'dotm'].includes(extension)) return 'docx';
  if (['xlsx', 'xlsm', 'xltx', 'xltm'].includes(extension)) return 'xlsx';
  if (['pptx', 'pptm', 'potx', 'potm'].includes(extension)) return 'pptx';
  if (extension === 'odt') return 'odt';
  if (extension === 'ods') return 'ods';
  if (extension === 'odp') return 'odp';
  if (extension === 'rtf') return 'rtf';

  return '';
}

export async function renderOfficePreview(name, blob) {
  const type = officeType(name);
  if (!type) throw new Error('This file type cannot be read here');

  if (type === 'rtf') return renderRtf(await blob.text());

  const archive = await openArchive(blob);

  if (type === 'docx') return readDocx(archive);
  if (type === 'xlsx') return renderWorkbook(archive);
  if (type === 'pptx') return readPptx(archive);

  return renderOpenDocument(archive, type);
}
