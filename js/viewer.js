/* Zoom + all-pages viewer for the preview panel.
 *
 * - PDFs are drawn page by page with the vendored PDF.js (loaded on demand), so
 *   every page is scrollable and zooming re-renders the pages sharply. If
 *   PDF.js cannot be loaded the caller falls back to the browser's own viewer.
 * - Word, PowerPoint, Excel, OpenDocument, RTF and CSV previews are wrapped in
 *   a scalable stage, so they get the same zoom controls.
 *
 * Zoom works with the toolbar buttons, + / - / 0 on the keyboard, Ctrl/Cmd +
 * mouse wheel (also a trackpad pinch on desktop) and a two-finger pinch on
 * touch screens. A page indicator with a "jump to page" box covers every page,
 * slide or sheet.
 */

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

const MAX_PDF_PAGES = 2000;
const MAX_CANVAS_PIXELS = 15000000; // stays under the iOS canvas limit

let current = null; // the viewer that is currently mounted

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const $ = (selector) => document.querySelector(selector);

/* ------------------------------------------------------------------ */
/* PDF.js loader (vendored, fetched only when a PDF is opened)         */
/* ------------------------------------------------------------------ */

let pdfJsPromise = null;

function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = import(new URL('../vendor/pdfjs/pdf.min.mjs', import.meta.url).href)
      .then((pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
        return pdfjs;
      })
      .catch((error) => {
        pdfJsPromise = null; // allow a retry next time a PDF is opened
        throw error;
      });
  }

  return pdfJsPromise;
}

/* ------------------------------------------------------------------ */
/* Toolbar + gestures shared by every kind of file                     */
/* ------------------------------------------------------------------ */

function createController({ body, strategy, getPages, pageLabel }) {
  const bar = $('#preview-zoombar');
  const levelButton = $('#zoom-level');
  const pageInput = $('#page-input');
  const pageTotal = $('#page-total');
  const pageNav = $('#page-nav');
  const pageLabelNode = $('#page-label');

  let zoom = strategy.initialZoom();
  let pageIndex = 0;
  let frame = 0;
  let pinch = null;
  const cleanups = [];

  const on = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  };

  function updateUi() {
    if (levelButton) levelButton.textContent = `${Math.round(zoom * 100)}%`;
    const out = $('#zoom-out');
    const zin = $('#zoom-in');
    if (out) out.disabled = zoom <= MIN_ZOOM + 0.001;
    if (zin) zin.disabled = zoom >= MAX_ZOOM - 0.001;
  }

  function setZoom(next, anchor) {
    next = Math.round(clamp(next, MIN_ZOOM, MAX_ZOOM) * 100) / 100;
    if (Math.abs(next - zoom) < 0.001) return;

    // Keep the point under the finger / cursor (or the centre of the view)
    // where it is while the content grows or shrinks around it.
    const bodyRect = body.getBoundingClientRect();
    const anchorX = anchor ? anchor.x : bodyRect.left + body.clientWidth / 2;
    const anchorY = anchor ? anchor.y : bodyRect.top + body.clientHeight / 2;
    const before = strategy.box.getBoundingClientRect();
    const fractionX = (anchorX - before.left) / (before.width || 1);
    const fractionY = (anchorY - before.top) / (before.height || 1);

    zoom = next;
    strategy.apply(zoom);

    const after = strategy.box.getBoundingClientRect();
    body.scrollLeft += after.left + fractionX * after.width - anchorX;
    body.scrollTop += after.top + fractionY * after.height - anchorY;
    updateUi();
  }

  function zoomIn() {
    const next = STEPS.find((step) => step > zoom + 0.001);
    setZoom(next || MAX_ZOOM);
  }

  function zoomOut() {
    const smaller = STEPS.filter((step) => step < zoom - 0.001);
    setZoom(smaller.length ? smaller[smaller.length - 1] : MIN_ZOOM);
  }

  function reset() {
    setZoom(strategy.initialZoom());
  }

  function fit() {
    setZoom(strategy.fitZoom());
  }

  /* ----- page indicator ----- */

  function pages() {
    return getPages ? Array.from(getPages()) : [];
  }

  function refreshPages() {
    const list = pages();
    if (pageNav) pageNav.classList.toggle('hidden', list.length === 0);
    if (pageLabelNode) pageLabelNode.textContent = pageLabel || 'Page';
    if (pageTotal) pageTotal.textContent = `/ ${list.length}`;
    if (pageInput) {
      pageInput.max = String(list.length);
      pageInput.setAttribute('aria-label', `${pageLabel || 'Page'} number`);
    }
    updateCurrentPage();
  }

  function updateCurrentPage() {
    frame = 0;
    const list = pages();
    if (!list.length) return;

    const bodyRect = body.getBoundingClientRect();
    const middle = bodyRect.top + body.clientHeight * 0.35;
    let index = clamp(pageIndex, 0, list.length - 1);

    while (index > 0 && list[index].getBoundingClientRect().top > middle) index -= 1;
    while (index < list.length - 1 && list[index].getBoundingClientRect().bottom <= middle) index += 1;

    // At the very bottom the last page counts as current even when a short
    // final page/sheet cannot reach the reading line.
    if (list.length > 1 && body.scrollTop + body.clientHeight >= body.scrollHeight - 2) {
      index = list.length - 1;
    }

    pageIndex = index;
    if (pageInput && document.activeElement !== pageInput) pageInput.value = String(index + 1);
  }

  function goToPage(number) {
    const list = pages();
    if (!list.length) return;
    const index = clamp(Math.round(number) - 1, 0, list.length - 1);
    const bodyRect = body.getBoundingClientRect();
    const target = list[index].getBoundingClientRect();
    body.scrollTop += target.top - bodyRect.top - 8;
    pageIndex = index;
    if (pageInput) pageInput.value = String(index + 1);
  }

  /* ----- wiring ----- */

  const press = (id, handler) => {
    const node = $(id);
    if (!node) return;
    node.onclick = handler;
    cleanups.push(() => {
      node.onclick = null;
    });
  };

  press('#zoom-in', zoomIn);
  press('#zoom-out', zoomOut);
  press('#zoom-level', reset);
  press('#zoom-fit', fit);

  if (pageInput) {
    pageInput.onchange = () => goToPage(Number(pageInput.value) || 1);
    pageInput.onkeydown = (event) => {
      if (event.key !== 'Escape') event.stopPropagation(); // arrows must not switch files while typing
      if (event.key === 'Enter') {
        goToPage(Number(pageInput.value) || 1);
        pageInput.blur();
      }
    };
    cleanups.push(() => {
      pageInput.onchange = null;
      pageInput.onkeydown = null;
    });
  }

  on(
    body,
    'wheel',
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom(zoom * Math.exp(-event.deltaY * 0.0125), { x: event.clientX, y: event.clientY });
    },
    { passive: false }
  );

  const distance = (touches) =>
    Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);

  on(
    body,
    'touchstart',
    (event) => {
      if (event.touches.length === 2) pinch = { distance: distance(event.touches), zoom };
    },
    { passive: true }
  );

  on(
    body,
    'touchmove',
    (event) => {
      if (!pinch || event.touches.length !== 2) return;
      event.preventDefault();
      const [a, b] = [event.touches[0], event.touches[1]];
      setZoom(pinch.zoom * (distance(event.touches) / (pinch.distance || 1)), {
        x: (a.clientX + b.clientX) / 2,
        y: (a.clientY + b.clientY) / 2,
      });
    },
    { passive: false }
  );

  const endPinch = (event) => {
    if (event.touches.length < 2) pinch = null;
  };
  on(body, 'touchend', endPinch, { passive: true });
  on(body, 'touchcancel', endPinch, { passive: true });

  on(
    body,
    'scroll',
    () => {
      if (!frame) frame = requestAnimationFrame(updateCurrentPage);
    },
    { passive: true }
  );

  on(document, 'keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomIn();
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      zoomOut();
    } else if (event.key === '0') {
      event.preventDefault();
      reset();
    }
  });

  on(window, 'resize', () => {
    strategy.resize(zoom);
  });

  if (bar) bar.classList.remove('hidden');
  body.classList.add('zoomable');
  body.tabIndex = 0;

  strategy.apply(zoom);
  updateUi();
  refreshPages();

  return {
    refreshPages,
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      cleanups.splice(0).forEach((cleanup) => cleanup());
      strategy.destroy();
      body.classList.remove('zoomable');
      body.removeAttribute('tabindex');
      if (bar) bar.classList.add('hidden');
      if (pageNav) pageNav.classList.add('hidden');
    },
  };
}

/* ------------------------------------------------------------------ */
/* Scaled stage for Word / PowerPoint / Excel / CSV                    */
/* ------------------------------------------------------------------ */

function scaledStrategy(body, content, mode, minInitial = 0) {
  const sizer = document.createElement('div');
  sizer.className = 'zoom-sizer';
  const stage = document.createElement('div');
  stage.className = 'zoom-content';
  stage.appendChild(content);
  sizer.appendChild(stage);
  body.appendChild(sizer);

  let zoom = 1;
  let naturalWidth = 1;
  let naturalHeight = 1;

  const available = () => {
    const style = getComputedStyle(body);
    return Math.max(
      200,
      body.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0')
    );
  };

  function measure() {
    // "fill" content (slides, text documents) flows to the available width;
    // "max" content (Word pages, spreadsheets) keeps the width it asks for.
    stage.style.width = mode === 'fill' ? `${available()}px` : 'max-content';
    naturalWidth = Math.max(1, stage.offsetWidth);
    naturalHeight = Math.max(1, stage.offsetHeight);
  }

  function place() {
    stage.style.transform = `scale(${zoom})`;
    sizer.style.width = `${naturalWidth * zoom}px`;
    sizer.style.height = `${naturalHeight * zoom}px`;
  }

  let observer = null;
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(() => {
      measure();
      place();
    });
    observer.observe(stage);
  }

  measure();

  const fitZoom = () => clamp(available() / naturalWidth, MIN_ZOOM, MAX_ZOOM);

  return {
    box: sizer,
    // A Word page or wide sheet starts shrunk to fit the screen instead of
    // forcing sideways scrolling; slides already fit.
    initialZoom: () =>
      mode === 'fill' ? 1 : Math.round(clamp(Math.min(1, fitZoom()), minInitial, 1) * 100) / 100,
    fitZoom,
    apply(next) {
      zoom = next;
      measure();
      place();
    },
    resize(next) {
      zoom = next;
      measure();
      place();
    },
    destroy() {
      if (observer) observer.disconnect();
      // Hand the content back so the body can be cleared normally.
      if (content.parentNode === stage) body.appendChild(content);
      sizer.remove();
    },
  };
}

/* ------------------------------------------------------------------ */
/* PDF strategy                                                        */
/* ------------------------------------------------------------------ */

async function pdfStrategy(body, blob, isCurrent) {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await blob.arrayBuffer());
  const loadingTask = pdfjs.getDocument({ data });
  const doc = await loadingTask.promise;

  const count = Math.min(doc.numPages, MAX_PDF_PAGES);
  const first = await doc.getPage(1);
  const firstView = first.getViewport({ scale: 1 });

  // The person may have opened another file while this one was loading.
  if (isCurrent && !isCurrent()) {
    try {
      loadingTask.destroy();
    } catch (error) {
      /* already gone */
    }
    const stale = new Error('Preview was replaced');
    stale.stale = true;
    throw stale;
  }

  const holder = document.createElement('div');
  holder.className = 'pdf-pages';

  const records = [];
  for (let index = 0; index < count; index += 1) {
    const element = document.createElement('div');
    element.className = 'pdf-page';
    element.dataset.page = String(index + 1);
    element.style.aspectRatio = `${firstView.width} / ${firstView.height}`;
    holder.appendChild(element);
    records.push({
      index: index + 1,
      element,
      page: index === 0 ? first : null,
      renderedWidth: 0,
      busy: false,
      task: null,
    });
  }

  body.appendChild(holder);

  let zoom = 1;
  let destroyed = false;
  let timer = 0;
  let running = false;
  const visible = new Set();

  const available = () => {
    const style = getComputedStyle(body);
    return Math.max(
      200,
      body.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0')
    );
  };
  const baseWidth = () => Math.min(available(), 960);

  // Real page sizes arrive in the background so mixed-size PDFs lay out right.
  records.forEach((record) => {
    if (record.page) return;
    doc
      .getPage(record.index)
      .then((page) => {
        if (destroyed) return;
        record.page = page;
        const view = page.getViewport({ scale: 1 });
        record.element.style.aspectRatio = `${view.width} / ${view.height}`;
      })
      .catch(() => {});
  });

  async function renderRecord(record) {
    const cssWidth = baseWidth() * zoom;
    const key = Math.round(cssWidth);
    if (record.renderedWidth === key || destroyed) return;

    const page = record.page || (await doc.getPage(record.index));
    record.page = page;

    const unit = page.getViewport({ scale: 1 });
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    let scale = (cssWidth / unit.width) * ratio;
    const pixels = unit.width * scale * unit.height * scale;
    if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);

    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));

    if (record.task) record.task.cancel();
    const task = page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport });
    record.task = task;

    try {
      await task.promise;
    } catch (error) {
      if (error && error.name === 'RenderingCancelledException') return;
      throw error;
    } finally {
      if (record.task === task) record.task = null;
    }

    if (destroyed) return;
    record.element.replaceChildren(canvas);
    record.renderedWidth = key;
  }

  async function renderVisible() {
    if (running || destroyed) return;
    running = true;
    try {
      const wanted = records.filter((record) => visible.has(record));
      for (const record of wanted) {
        if (destroyed) break;
        try {
          await renderRecord(record);
        } catch (error) {
          console.warn('Could not draw PDF page', record.index, error);
        }
      }
    } finally {
      running = false;
    }

    // Zoom may have changed while rendering; pick up anything now stale.
    const stale = records.some(
      (record) => visible.has(record) && record.renderedWidth !== Math.round(baseWidth() * zoom)
    );
    if (stale && !destroyed) schedule(60);
  }

  function schedule(delay = 140) {
    clearTimeout(timer);
    timer = setTimeout(renderVisible, delay);
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const record = records[Number(entry.target.dataset.page) - 1];
        if (!record) return;
        if (entry.isIntersecting) {
          visible.add(record);
        } else {
          visible.delete(record);
          // Free the memory of pages that are far from the view.
          if (record.task) record.task.cancel();
          record.element.replaceChildren();
          record.renderedWidth = 0;
          if (record.page && record.index !== 1) record.page.cleanup();
        }
      });
      schedule(40);
    },
    { root: body, rootMargin: '900px 0px' }
  );
  records.forEach((record) => observer.observe(record.element));

  function layout(next) {
    zoom = next;
    holder.style.width = `${baseWidth() * zoom}px`;
    schedule();
  }

  return {
    box: holder,
    pages: () => holder.children,
    initialZoom: () => 1,
    fitZoom: () => 1,
    apply: layout,
    resize: layout,
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      observer.disconnect();
      records.forEach((record) => record.task && record.task.cancel());
      holder.remove();
      try {
        loadingTask.destroy();
      } catch (error) {
        /* already gone */
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export function closeViewer() {
  if (current) {
    current.destroy();
    current = null;
  }
  const bar = $('#preview-zoombar');
  if (bar) bar.classList.add('hidden');
}

/**
 * Wraps content that is already in `body` (a Word page stack, a deck, a sheet
 * grid...) in a zoomable stage.
 *   mode: 'max'  — keeps its natural width (Word pages, spreadsheets)
 *         'fill' — flows to the available width (slides, text documents)
 *   pageSelector / pageLabel — what counts as a "page" for the page box.
 *   minInitial — lowest starting zoom, so wide sheets stay readable on a phone.
 */
export function mountScaled(
  body,
  content,
  { mode = 'fill', pageSelector = '', pageLabel = 'Page', minInitial = 0 } = {}
) {
  closeViewer();
  const strategy = scaledStrategy(body, content, mode, minInitial);
  current = createController({
    body,
    strategy,
    pageLabel,
    getPages: pageSelector ? () => content.querySelectorAll(pageSelector) : null,
  });
  return current;
}

/** Draws every page of a PDF. Throws if PDF.js or the file cannot be loaded. */
export async function mountPdf(body, blob, isCurrent) {
  closeViewer();
  const strategy = await pdfStrategy(body, blob, isCurrent);
  current = createController({
    body,
    strategy,
    pageLabel: 'Page',
    getPages: strategy.pages,
  });
  return current;
}
