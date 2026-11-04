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

function renderParagraphs(paragraphs, className, pageRatio) {
  const body = paragraphs
    .map((text) => (text ? `<p>${escapeHtml(text)}</p>` : '<p class="office-gap"></p>'))
    .join('');
  const ratio = pageRatio ? ` style="--page-ratio:${pageRatio.toFixed(4)}"` : '';
  return `<div class="preview-doc"><div class="doc-page ${className}"${ratio}>${
    body || '<p class="muted">This document has no readable text.</p>'
  }</div></div>`;
}

// Reads the page size Word stored (twips: 1440 per inch) so the preview has
// the shape of the real page instead of an arbitrary column.
function docPageRatio(doc) {
  const size = doc.getElementsByTagName('w:pgSz')[0];
  if (!size) return 0;
  const width = Number(size.getAttribute('w:w') || 0);
  const height = Number(size.getAttribute('w:h') || 0);
  if (!width || !height) return 0;
  return width / height;
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

  return renderParagraphs(paragraphs, 'office-docx', docPageRatio(doc));
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

function columnName(index) {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function renderGrid(sheetName, rows, withHeaders = false) {
  const trimmed = rows.map(trimRow).filter((cells) => cells.length > 0);
  const heading = sheetName ? `<h3 class="office-sheet-name">${escapeHtml(sheetName)}</h3>` : '';

  if (!trimmed.length) {
    return `<div class="office-sheet">${heading}<p class="muted">This sheet is empty.</p></div>`;
  }

  const widest = trimmed.reduce((most, cells) => Math.max(most, cells.length), 0);
  const columnCount = Math.min(Math.max(widest, withHeaders ? 5 : 1), MAX_COLUMNS);

  const headerRow = withHeaders
    ? `<tr class="sheet-head"><td class="sheet-corner"></td>${Array.from(
        { length: columnCount },
        (_, column) => `<td>${columnName(column)}</td>`
      ).join('')}</tr>`
    : '';

  const body = trimmed
    .map((cells, rowIndex) => {
      const tds = [];
      const rowNumber = withHeaders ? `<td class="sheet-row-head">${rowIndex + 1}</td>` : '';
      for (let column = 0; column < columnCount; column += 1) {
        const value = cells[column] === undefined ? '' : String(cells[column]).slice(0, MAX_CELL_CHARS);
        tds.push(`<td>${escapeHtml(value)}</td>`);
      }
      return `<tr>${rowNumber}${tds.join('')}</tr>`;
    })
    .join('');

  return `<div class="office-sheet">
      ${heading}
      <div class="office-scroll">
        <table class="office-table${withHeaders ? ' office-table-sheet' : ''}">
          <thead>${headerRow}</thead>
          <tbody>${body}</tbody>
        </table>
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
    parts.push(renderGrid(names[index] || `Sheet ${index + 1}`, rows, true));
  }

  return `<div class="preview-doc office-stack">${parts.join('')}</div>`;
}

/* ------------------------------------------------------------------ */
/* PowerPoint (.pptx / .odp)                                           */
/* ------------------------------------------------------------------ */

function renderSlides(slides, slideRatio) {
  if (!slides.length) {
    return '<div class="preview-doc"><div class="office-doc"><p class="muted">This presentation has no readable text.</p></div></div>';
  }

  const total = slides.length;
  const ratio = slideRatio ? ` style="--slide-ratio:${slideRatio.toFixed(4)}"` : '';

  const pages = slides
    .map((slide) => {
      const paragraphs = slide.paragraphs;
      const title = paragraphs.length ? paragraphs[0] : '';
      const bullets = paragraphs.slice(1);

      return `<section class="slide-page" data-slide="${slide.number}">
        <div class="slide-inner">
          ${title ? `<h4 class="slide-title">${escapeHtml(title)}</h4>` : ''}
          ${
            bullets.length
              ? `<ul class="slide-bullets">${bullets.map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul>`
              : ''
          }
          ${title || bullets.length ? '' : '<p class="slide-empty">This slide has no text.</p>'}
        </div>
        <span class="slide-number">Slide ${slide.number} of ${total}</span>
      </section>`;
    })
    .join('');

  return `<div class="preview-doc deck"${ratio}>
      <div class="deck-scroll">${pages}</div>
    </div>`;
}

// The size of the slides as saved in the file (EMU: 914400 per inch), so a
// 4:3 deck renders 4:3 instead of being forced into 16:9.
async function presentationRatio(archive) {
  const bytes = await readEntry(archive, 'ppt/presentation.xml');
  if (!bytes) return 0;
  const doc = parseXml(bytes);
  const size = doc.getElementsByTagName('p:sldSz')[0];
  if (!size) return 0;
  const width = Number(size.getAttribute('cx') || 0);
  const height = Number(size.getAttribute('cy') || 0);
  if (!width || !height) return 0;
  return width / height;
}

/* ------------------------------------------------------------------ */
/* PowerPoint: draw the slide's real shapes                            */
/* ------------------------------------------------------------------ */

const EMU_PER_INCH = 914400;

function percentOf(value, total) {
  if (!total) return 0;
  return Math.max(-50, Math.min(150, (Number(value || 0) / Number(total)) * 100));
}

function imageMime(path) {
  const ext = extensionOf(path);
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'bmp') return 'image/bmp';
  if (ext === 'tif' || ext === 'tiff') return 'image/tiff';
  return '';
}

async function readRelationships(archive, partPath) {
  const slash = partPath.lastIndexOf('/');
  const dir = partPath.slice(0, slash + 1);
  const name = partPath.slice(slash + 1);
  const bytes = await readEntry(archive, `${dir}_rels/${name}.rels`);
  const map = new Map();
  if (!bytes) return map;

  const doc = parseXml(bytes);
  const nodes = doc.getElementsByTagName('Relationship');
  for (let index = 0; index < nodes.length; index += 1) {
    const id = nodes[index].getAttribute('Id');
    const target = nodes[index].getAttribute('Target');
    if (!id || !target) continue;
    const resolved = target.startsWith('/') ? target.slice(1) : `${dir}${target}`;
    map.set(id, resolved.replace(/\/\.\//g, '/'));
  }
  return map;
}

async function themeColours(archive) {
  const colours = {
    dk1: '#000000',
    lt1: '#ffffff',
    dk2: '#44546a',
    lt2: '#e7e6e6',
    accent1: '#4472c4',
    accent2: '#ed7d31',
    accent3: '#a5a5a5',
    accent4: '#ffc000',
    accent5: '#5b9bd5',
    accent6: '#70ad47',
    hlink: '#0563c1',
    folHlink: '#954f72',
  };

  const bytes = await readEntry(archive, 'ppt/theme/theme1.xml');
  if (!bytes) return colours;

  const doc = parseXml(bytes);
  const scheme = doc.getElementsByTagName('a:clrScheme')[0];
  if (!scheme) return colours;

  for (const slot of Array.from(scheme.children)) {
    const srgb = slot.getElementsByTagName('a:srgbClr')[0];
    const sys = slot.getElementsByTagName('a:sysClr')[0];
    const hex = srgb ? srgb.getAttribute('val') : sys ? sys.getAttribute('lastClr') : '';
    if (hex) colours[slot.localName] = `#${hex}`;
  }
  return colours;
}

function colourFrom(node, theme) {
  if (!node) return '';
  const solid = node.getElementsByTagName('a:solidFill')[0];
  if (!solid) return '';

  const srgb = solid.getElementsByTagName('a:srgbClr')[0];
  if (srgb && srgb.getAttribute('val')) return `#${srgb.getAttribute('val')}`;

  const scheme = solid.getElementsByTagName('a:schemeClr')[0];
  if (scheme) {
    const name = scheme.getAttribute('val');
    if (theme[name]) return theme[name];
    if (name === 'tx1') return theme.dk1;
    if (name === 'bg1') return theme.lt1;
    if (name === 'tx2') return theme.dk2;
    if (name === 'bg2') return theme.lt2;
  }
  return '';
}

function shapeGeometry(element) {
  const transform = element.getElementsByTagName('a:xfrm')[0];
  if (!transform) return null;
  const offset = transform.getElementsByTagName('a:off')[0];
  const extent = transform.getElementsByTagName('a:ext')[0];
  if (!offset || !extent) return null;
  return {
    x: Number(offset.getAttribute('x') || 0),
    y: Number(offset.getAttribute('y') || 0),
    width: Number(extent.getAttribute('cx') || 0),
    height: Number(extent.getAttribute('cy') || 0),
  };
}

function runsHtml(paragraph, ctx) {
  let html = '';
  for (const child of Array.from(paragraph.children)) {
    if (child.localName === 'br') {
      html += '<br>';
      continue;
    }
    if (child.localName !== 'r' && child.localName !== 'fld') continue;

    const text = collectText(child, 'a:t');
    if (!text) continue;

    const properties = child.getElementsByTagName('a:rPr')[0];
    const style = [];
    const points = properties && properties.getAttribute('sz') ? Number(properties.getAttribute('sz')) / 100 : 18;
    style.push(`font-size:${ctx.pointsToCqw(points).toFixed(3)}cqw`);

    if (properties) {
      if (properties.getAttribute('b') === '1') style.push('font-weight:700');
      if (properties.getAttribute('i') === '1') style.push('font-style:italic');
      const underline = properties.getAttribute('u');
      if (underline && underline !== 'none') style.push('text-decoration:underline');
      const colour = colourFrom(properties, ctx.theme);
      if (colour) style.push(`color:${colour}`);
    }

    html += `<span style="${style.join(';')}">${escapeHtml(text)}</span>`;
  }
  return html;
}

function textBodyHtml(txBody, ctx) {
  if (!txBody) return '';
  let html = '';
  const paragraphs = txBody.getElementsByTagName('a:p');

  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index];
    const properties = paragraph.getElementsByTagName('a:pPr')[0];
    const align = properties ? properties.getAttribute('algn') : '';
    const style = [];
    if (align === 'ctr') style.push('text-align:center');
    else if (align === 'r') style.push('text-align:right');
    else if (align === 'just') style.push('text-align:justify');

    const bullet = properties && properties.getElementsByTagName('a:buChar').length ? '&#8226; ' : '';
    const runs = runsHtml(paragraph, ctx);
    if (!runs && !bullet) {
      html += '<p>&nbsp;</p>';
      continue;
    }
    html += `<p style="${style.join(';')}">${bullet}${runs}</p>`;
  }
  return html;
}

function positionedBox(geometry, inner, className, background, anchor, ctx) {
  const style = [
    `left:${percentOf(geometry.x, ctx.width).toFixed(3)}%`,
    `top:${percentOf(geometry.y, ctx.height).toFixed(3)}%`,
    `width:${percentOf(geometry.width, ctx.width).toFixed(3)}%`,
    `height:${percentOf(geometry.height, ctx.height).toFixed(3)}%`,
  ];
  if (background) style.push(`background:${background}`);
  if (anchor === 'ctr') style.push('justify-content:center');
  else if (anchor === 'b') style.push('justify-content:flex-end');

  return `<div class="${className}" style="${style.join(';')}">${inner}</div>`;
}

async function shapeHtml(element, ctx, archive) {
  const name = element.localName;

  if (name === 'pic') {
    const geometry = shapeGeometry(element);
    const blip = element.getElementsByTagName('a:blip')[0];
    const relationId = blip ? blip.getAttribute('r:embed') : '';
    const path = relationId ? ctx.relationships.get(relationId) : '';
    if (!geometry || !path) return '';

    if (!ctx.images.has(path)) {
      const mime = imageMime(path);
      const bytes = mime ? await readEntry(archive, path) : null;
      ctx.images.set(path, bytes ? `data:${mime};base64,${base64FromBytes(bytes)}` : '');
    }
    const source = ctx.images.get(path);
    if (!source) return '';

    return positionedBox(geometry, `<img src="${source}" alt="" />`, 'slide-shape slide-image', '', '', ctx);
  }

  if (name === 'graphicFrame') {
    const table = element.getElementsByTagName('a:tbl')[0];
    if (!table) return '';
    const geometry = shapeGeometry(element);
    if (!geometry) return '';

    const rows = [];
    const rowNodes = table.getElementsByTagName('a:tr');
    for (let rowIndex = 0; rowIndex < rowNodes.length; rowIndex += 1) {
      const cells = [];
      const cellNodes = rowNodes[rowIndex].getElementsByTagName('a:tc');
      for (let cellIndex = 0; cellIndex < cellNodes.length; cellIndex += 1) {
        const body = cellNodes[cellIndex].getElementsByTagName('a:txBody')[0];
        cells.push(`<td>${textBodyHtml(body, ctx)}</td>`);
      }
      rows.push(`<tr>${cells.join('')}</tr>`);
    }

    return positionedBox(
      geometry,
      `<table class="slide-table">${rows.join('')}</table>`,
      'slide-shape slide-table-box',
      '',
      '',
      ctx
    );
  }

  if (name === 'sp') {
    const body = element.getElementsByTagName('p:txBody')[0];
    const inner = textBodyHtml(body, ctx);
    const geometry = shapeGeometry(element);
    const background = colourFrom(element.getElementsByTagName('p:spPr')[0], ctx.theme);

    if (!geometry) {
      if (!inner) return '';
      return `<div class="slide-shape slide-flow"${background ? ` style="background:${background}"` : ''}>${inner}</div>`;
    }

    const bodyProperties = element.getElementsByTagName('a:bodyPr')[0];
    const anchor = bodyProperties ? bodyProperties.getAttribute('anchor') : '';
    return positionedBox(geometry, inner, 'slide-shape', background, anchor, ctx);
  }

  return '';
}

function base64FromBytes(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function slideBackground(doc, theme) {
  const background = doc.getElementsByTagName('p:bg')[0];
  if (!background) return '';
  return colourFrom(background, theme);
}

async function readPptx(archive) {
  const presentation = await readEntry(archive, 'ppt/presentation.xml');
  let widthEmu = 12192000;
  let heightEmu = 6858000;

  if (presentation) {
    const presDoc = parseXml(presentation);
    const size = presDoc.getElementsByTagName('p:sldSz')[0];
    if (size) {
      widthEmu = Number(size.getAttribute('cx') || widthEmu);
      heightEmu = Number(size.getAttribute('cy') || heightEmu);
    }
  }

  const theme = await themeColours(archive);
  const referencePx = (widthEmu / EMU_PER_INCH) * 96 || 1280;
  const ctx = {
    theme,
    width: widthEmu,
    height: heightEmu,
    images: new Map(),
    relationships: new Map(),
    // 1pt = 4/3 px at 96 dpi; cqw is 1% of the slide's own width.
    pointsToCqw: (points) => (points * (4 / 3) * 100) / referencePx,
  };

  const found = [];
  archive.entries.forEach((entry) => {
    const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(entry.name);
    if (match) found.push({ path: entry.name, index: Number(match[1]) });
  });
  found.sort((a, b) => a.index - b.index);

  const pages = [];
  const textOnly = [];

  for (const item of found.slice(0, MAX_SLIDES)) {
    const bytes = await readEntry(archive, item.path);
    if (!bytes) continue;

    const doc = parseXml(bytes);
    const relationships = await readRelationships(archive, item.path);
    const slideCtx = Object.assign({}, ctx, { relationships });

    // Plain text, used if the deck turns out to have no drawable shapes.
    const paragraphs = [];
    const textNodes = doc.getElementsByTagName('a:p');
    for (let index = 0; index < textNodes.length; index += 1) {
      const text = collectText(textNodes[index], 'a:t').replace(/\s+/g, ' ').trim();
      if (text) paragraphs.push(text);
    }
    textOnly.push({ number: item.index, paragraphs });

    let shapes = '';
    const tree = doc.getElementsByTagName('p:spTree')[0];
    if (tree) {
      for (const child of Array.from(tree.children)) {
        if (child.localName === 'sp' || child.localName === 'pic' || child.localName === 'graphicFrame') {
          shapes += await shapeHtml(child, slideCtx, archive);
        }
      }
    }

    pages.push({ number: item.index, shapes, background: slideBackground(doc, theme) });
  }

  if (!pages.some((page) => page.shapes)) {
    return renderSlides(textOnly, heightEmu ? widthEmu / heightEmu : 0);
  }

  const ratio = heightEmu ? widthEmu / heightEmu : 16 / 9;
  const frames = pages
    .map(
      (page, index) => `<section class="slide-frame">
        <div class="slide-canvas" style="background:${page.background || '#ffffff'}">${page.shapes}</div>
        <span class="slide-number">Slide ${page.number || index + 1} of ${pages.length}</span>
      </section>`
    )
    .join('');

  return `<div class="preview-doc deck" style="--slide-ratio:${ratio.toFixed(4)}">
      <div class="deck-scroll">${frames}</div>
    </div>`;
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
      parts.push(renderGrid(tables[tableIndex].getAttribute('table:name') || `Sheet ${tableIndex + 1}`, rows, true));
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


/* ------------------------------------------------------------------ */
/* Faithful Word rendering (vendored docx-preview)                     */
/* ------------------------------------------------------------------ */

// docx-preview draws the real document: pages, tables, images, headings and
// fonts. It is ~170 KB of library, so the two scripts are fetched only when a
// Word file is actually opened, and any failure falls back to the plain-text
// reader above rather than leaving the preview empty.
let docxLibraries = null;

function loadScript(source) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-dd-vendor="${source}"]`);
    if (existing) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = source;
    script.async = true;
    script.dataset.ddVendor = source;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load the document renderer'));
    document.head.appendChild(script);
  });
}

async function ensureDocxLibraries() {
  if (docxLibraries) return docxLibraries;

  docxLibraries = (async () => {
    const base = new URL('../vendor/', import.meta.url);
    await loadScript(new URL('jszip.min.js', base).href);
    await loadScript(new URL('docx-preview.min.js', base).href);
  })();

  return docxLibraries;
}

export async function renderDocxFaithful(blob, container) {
  try {
    await ensureDocxLibraries();
  } catch (error) {
    return false;
  }

  if (!window.JSZip || !window.docx || typeof window.docx.renderAsync !== 'function') return false;

  try {
    container.innerHTML = '';
    await window.docx.renderAsync(blob, container, null, {
      className: 'docx',
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      breakPages: true,
      renderHeaders: true,
      renderFooters: true,
      useBase64URL: true,
    });
    return true;
  } catch (error) {
    console.warn('docx-preview could not lay out this document', error);
    return false;
  }
}
