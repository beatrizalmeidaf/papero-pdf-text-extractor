// Layout editor: correct the extraction by hand, on the page. A block is moved, resized,
// drawn, reclassified, merged with others, deleted or put elsewhere in the reading order;
// whenever its region changes, its content is read again from the PDF the same way the
// extraction reads it (engine.readRegion). Every other view and export works on the edited
// document, so the Markdown and the Word file follow each change.

import { cropRegion, pageGlyphs, readRegion } from "./engine.js";
import { blockMarkdown, esc } from "./export.js";

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const MIN_SIZE = 4; // pt: a smaller box is a slip of the mouse
const DRAG_START = 3; // px before a press becomes a drag
const CONTENT = ["text", "rows", "latex", "number", "marker", "runs"];
const IMAGE_TYPES = new Set(["figure", "table", "formula"]);
const round = (v) => Math.round(v * 100) / 100;

/**
 * @param {object} ctx
 *   state       the app state ({ doc, pdf, edit, selection })
 *   list        the element holding the page wraps (#pages-list)
 *   tr, types, typeLabel, typeColor
 *   onEdited(pageNumbers, { typing })  re-draw these pages and refresh the other views
 *   onSelect()  the selection changed: mark the boxes, show the inspector
 *   renderMd(element, markdown)        Markdown (with LaTeX) into an element
 *   mathMode()  "unicode" | "latex"
 *   toast(message, error)
 */
export function createEditor(ctx) {
  const { state, list, tr } = ctx;
  const undoStack = [], redoStack = [];
  const glyphCache = new Map();
  let queue = Promise.resolve();
  let pending = 0;
  let cropCount = 0;

  // ---------------------------------------------------------------- document helpers
  const pageOf = (block) => state.doc.pages.find((p) => p.blocks.includes(block));
  const pageNumbered = (n) => state.doc.pages.find((p) => p.number === n);
  const renumber = (page) => page.blocks.forEach((b, n) => { b.order = n; b.id = `p${page.number}-b${n}`; });
  const hasImages = () => state.doc.pages.some((p) => p.blocks.some((b) => b.image?.data));
  const selectedIds = () => state.selection.map((b) => b.id);
  const selectIds = (ids) => {
    const all = state.doc.pages.flatMap((p) => p.blocks);
    state.selection = ids.map((id) => all.find((b) => b.id === id)).filter(Boolean);
  };

  // Work that reads the PDF is done one step at a time, in order.
  function enqueue(job) {
    pending++;
    ctx.onBusy?.(true);
    queue = queue.then(job).catch((e) => { console.error(e); ctx.toast(e.message || String(e), true); })
      .finally(() => { if (!--pending) ctx.onBusy?.(false); });
    return queue;
  }

  // ---------------------------------------------------------------- history
  const snapshot = () => ({ pages: state.doc.pages.map((p) => p.blocks.map((b) => ({ ...b }))), selection: selectedIds() });
  function record() {
    undoStack.push(snapshot());
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  }
  function travel(from, to) {
    const step = from.pop();
    if (!step) return;
    to.push(snapshot());
    state.doc.pages.forEach((p, i) => { p.blocks = step.pages[i].map((b) => ({ ...b })); });
    selectIds(step.selection);
    ctx.onEdited(state.doc.pages.map((p) => p.number));
    ctx.onSelect();
  }
  const undo = () => enqueue(() => travel(undoStack, redoStack));
  const redo = () => enqueue(() => travel(redoStack, undoStack));

  // ---------------------------------------------------------------- reading the PDF again
  function glyphsOf(number) {
    if (!state.pdf) return Promise.resolve(null);
    if (!glyphCache.has(number)) glyphCache.set(number, pageGlyphs(state.pdf, number).catch(() => null));
    return glyphCache.get(number);
  }

  // The block's content, read again from its region as its type.
  async function reread(block, page) {
    const glyphs = await glyphsOf(page.number);
    if (glyphs) {
      const found = readRegion(glyphs, block.bbox, block.type);
      for (const key of CONTENT) delete block[key];
      for (const [key, value] of Object.entries(found)) if (value !== null && value !== undefined) block[key] = value;
    } else {
      convertWithoutPdf(block);
    }
    delete block.line_boxes;
    if (block.type === "heading") block.level = block.level || 2;
    else if (block.type !== "list_item") delete block.level;
    if (state.pdf && (block.type === "figure" || (IMAGE_TYPES.has(block.type) && hasImages()))) {
      const crop = await cropRegion(state.pdf, page.number, block.bbox);
      if (crop) block.image = { name: `p${page.number}-${block.type}-e${++cropCount}.png`, mime: "image/png", ...crop };
    } else if (!IMAGE_TYPES.has(block.type)) {
      delete block.image;
    }
  }

  // No PDF to read (a document the server read from another format): convert what is there.
  function convertWithoutPdf(b) {
    const text = b.rows ? b.rows.map((r) => r.join(" ")).join("\n") : b.text || "";
    if (b.type === "table") {
      if (!b.rows) b.rows = text.split("\n").filter((l) => l.trim()).map((l) => l.split(/\t| {2,}| \| /).map((c) => c.trim()));
      b.text = b.rows.map((r) => r.join(" | ")).join("\n");
    } else {
      delete b.rows;
      b.text = text;
      if (b.type === "formula") b.latex = b.latex || text;
      else delete b.latex;
    }
    delete b.runs;
  }

  // ---------------------------------------------------------------- operations
  function changed(block) { block.edited = true; }

  function setGeometry(block, bbox, recordIt = true) {
    const page = pageOf(block);
    if (!page) return;
    if (recordIt) record();
    block.bbox = clamp(bbox, page);
    changed(block);
    ctx.onEdited([page.number]);
    return enqueue(async () => { await reread(block, page); ctx.onEdited([page.number]); ctx.onSelect(); });
  }

  function setType(blocks, type) {
    record();
    const pages = new Set();
    for (const b of blocks) {
      b.type = type;
      if (type === "heading") b.level = b.level && b.level <= 6 ? b.level : 2;
      changed(b);
      pages.add(pageOf(b));
    }
    ctx.onEdited([...pages].map((p) => p.number));
    return enqueue(async () => {
      for (const b of blocks) {
        const page = pageOf(b);
        if (page && b.bbox) await reread(b, page);
        else convertWithoutPdf(b);
      }
      ctx.onEdited([...pages].map((p) => p.number));
      ctx.onSelect();
    });
  }

  function setLevel(block, level) {
    record();
    block.level = level;
    changed(block);
    ctx.onEdited([pageOf(block).number]);
  }

  // Typed content. `recordIt`: false while the same field keeps being typed in.
  function setContent(block, value, recordIt) {
    if (recordIt) record();
    for (const key of ["runs", "line_boxes"]) delete block[key];
    if (block.type === "table") {
      block.rows = value.split("\n").filter((l) => l.trim()).map((l) => l.split("|").map((c) => c.trim()));
      block.text = block.rows.map((r) => r.join(" | ")).join("\n");
    } else if (block.type === "formula") {
      block.latex = value;
      block.text = value;
    } else {
      block.text = value;
    }
    changed(block);
    ctx.onEdited([pageOf(block).number], { typing: true });
  }

  function remove(blocks) {
    if (!blocks.length) return;
    record();
    const pages = new Set(blocks.map(pageOf).filter(Boolean));
    for (const p of pages) {
      p.blocks = p.blocks.filter((b) => !blocks.includes(b));
      renumber(p);
    }
    state.selection = [];
    ctx.onEdited([...pages].map((p) => p.number));
    ctx.onSelect();
  }

  // Several blocks into one, where the first in reading order was. Formulas, tables and
  // figures are read again over the joint region; text is joined.
  function merge(blocks) {
    const page = pageOf(blocks[0]);
    if (blocks.length < 2 || blocks.some((b) => pageOf(b) !== page)) {
      ctx.toast(tr("edit.mergePages"), true);
      return;
    }
    record();
    const parts = [...blocks].sort((a, b) => page.blocks.indexOf(a) - page.blocks.indexOf(b));
    const [first, ...rest] = parts;
    first.bbox = [0, 1, 2, 3].map((k) => (k < 2 ? Math.min : Math.max)(...parts.map((b) => b.bbox[k])));
    first.bbox = first.bbox.map(round);
    if (!IMAGE_TYPES.has(first.type)) {
      first.text = parts.map((b) => (b.rows ? b.rows.map((r) => r.join(" ")).join(" ") : b.text || "").trim()).filter(Boolean).join(" ");
      const runs = parts.flatMap((b, i) => [
        ...(i ? [{ text: " ", bold: false, italic: false, script: null }] : []),
        ...(b.runs || [{ text: (b.text || "").trim(), bold: false, italic: false, script: null }]),
      ]);
      if (parts.some((b) => b.runs)) first.runs = runs;
      else delete first.runs;
      delete first.line_boxes;
    }
    changed(first);
    page.blocks = page.blocks.filter((b) => !rest.includes(b));
    renumber(page);
    state.selection = [first];
    ctx.onEdited([page.number]);
    ctx.onSelect();
    if (IMAGE_TYPES.has(first.type)) return enqueue(async () => { await reread(first, page); ctx.onEdited([page.number]); ctx.onSelect(); });
  }

  // A new block over a region drawn on the page, put in the reading order where it sits.
  function add(page, bbox) {
    record();
    const block = { id: "", type: "paragraph", order: 0, bbox: clamp(bbox, page), text: "", edited: true };
    const cy = (b) => (b.bbox[1] + b.bbox[3]) / 2;
    const sameColumn = (b) => b.bbox && Math.min(b.bbox[2], block.bbox[2]) - Math.max(b.bbox[0], block.bbox[0]) > 0;
    let at = page.blocks.findIndex((b) => sameColumn(b) && cy(b) > cy(block));
    if (at < 0) {
      const before = page.blocks.map((b, i) => (sameColumn(b) && cy(b) <= cy(block) ? i : -1)).filter((i) => i >= 0);
      at = before.length ? before[before.length - 1] + 1 : page.blocks.length;
    }
    page.blocks.splice(at, 0, block);
    renumber(page);
    state.selection = [block];
    ctx.onEdited([page.number]);
    ctx.onSelect();
    return enqueue(async () => {
      await reread(block, page);
      // Lines starting with a marker are list items; one short bold line, a heading.
      if (/^\s*([•◦▪‣●○■□–—*-]|\(?\d{1,3}[.)]|\(?[a-z][.)])\s/.test(block.text || "")) {
        block.type = "list_item";
        await reread(block, page);
      }
      ctx.onEdited([page.number]);
      ctx.onSelect();
    });
  }

  // One step earlier or later in the reading order.
  function shift(block, step) {
    const page = pageOf(block);
    const i = page.blocks.indexOf(block), j = i + step;
    if (j < 0 || j >= page.blocks.length) return;
    record();
    [page.blocks[i], page.blocks[j]] = [page.blocks[j], page.blocks[i]];
    renumber(page);
    changed(block);
    ctx.onEdited([page.number]);
    ctx.onSelect();
  }

  function rereadSelected() {
    const blocks = state.selection.filter((b) => b.bbox);
    if (!blocks.length) return;
    record();
    return enqueue(async () => {
      for (const b of blocks) await reread(b, pageOf(b));
      ctx.onEdited([...new Set(blocks.map((b) => pageOf(b).number))]);
      ctx.onSelect();
    });
  }

  function clamp(bbox, page) {
    let [x0, y0, x1, y1] = bbox;
    if (x1 < x0) [x0, x1] = [x1, x0];
    if (y1 < y0) [y0, y1] = [y1, y0];
    const w = page.width || 1e6, h = page.height || 1e6;
    return [Math.max(0, x0), Math.max(0, y0), Math.min(w, x1), Math.min(h, y1)].map(round);
  }

  // ---------------------------------------------------------------- pointer: move, resize, draw
  list.addEventListener("pointerdown", (e) => {
    if (!state.edit || e.button !== 0) return;
    const wrap = e.target.closest(".page-wrap");
    if (!wrap) return;
    const page = pageNumbered(+wrap.dataset.page);
    if (!page?.width) return;
    const scale = +wrap.dataset.scale;
    const rect = wrap.getBoundingClientRect();
    const at = (ev) => [(ev.clientX - rect.left) / scale, (ev.clientY - rect.top) / scale];
    const start = at(e);
    const handle = e.target.closest(".handle")?.dataset.h;
    const el = e.target.closest(".box");
    const block = el && page.blocks.find((b) => b.id === el.dataset.id);
    e.preventDefault();
    wrap.setPointerCapture(e.pointerId);

    let mode, ghost = null, moved = false;
    const origin = block ? [...block.bbox] : null;
    if (block && e.shiftKey && !handle) {
      state.selection = state.selection.includes(block) ? state.selection.filter((b) => b !== block) : [...state.selection, block];
      ctx.onSelect();
      wrap.releasePointerCapture(e.pointerId);
      return;
    }
    if (block) {
      if (!state.selection.includes(block) || state.selection.length > 1) { state.selection = [block]; ctx.onSelect(); }
      mode = handle ? "resize" : "move";
    } else {
      mode = "draw";
      if (state.selection.length) { state.selection = []; ctx.onSelect(); }
    }
    const place = (node, [x0, y0, x1, y1]) => {
      node.style.left = `${Math.min(x0, x1) * scale - 1}px`;
      node.style.top = `${Math.min(y0, y1) * scale}px`;
      node.style.width = `${Math.abs(x1 - x0) * scale + 2}px`;
      node.style.height = `${Math.abs(y1 - y0) * scale}px`;
    };
    const target = () => {
      const [px, py] = at(last);
      const dx = px - start[0], dy = py - start[1];
      if (mode === "draw") return [start[0], start[1], px, py];
      let [x0, y0, x1, y1] = origin;
      if (mode === "move") return [x0 + dx, y0 + dy, x1 + dx, y1 + dy];
      if (handle.includes("w")) x0 += dx;
      if (handle.includes("e")) x1 += dx;
      if (handle.includes("n")) y0 += dy;
      if (handle.includes("s")) y1 += dy;
      return [x0, y0, x1, y1];
    };
    let last = e;
    const onMove = (ev) => {
      last = ev;
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < DRAG_START) return;
      moved = true;
      if (mode === "draw" && !ghost) {
        ghost = document.createElement("div");
        ghost.className = "box drawing";
        wrap.append(ghost);
      }
      place(ghost || el, target());
    };
    const onUp = () => {
      wrap.removeEventListener("pointermove", onMove);
      wrap.removeEventListener("pointerup", onUp);
      wrap.removeEventListener("pointercancel", onUp);
      ghost?.remove();
      if (!moved) return;
      const [x0, y0, x1, y1] = target();
      const big = Math.abs(x1 - x0) >= MIN_SIZE && Math.abs(y1 - y0) >= MIN_SIZE;
      if (mode === "draw") { if (big) add(page, [x0, y0, x1, y1]); return; }
      if (!big) { ctx.onEdited([page.number]); return; } // too small: put it back
      setGeometry(block, [x0, y0, x1, y1]);
    };
    wrap.addEventListener("pointermove", onMove);
    wrap.addEventListener("pointerup", onUp);
    wrap.addEventListener("pointercancel", onUp);
  });

  // ---------------------------------------------------------------- keyboard
  let nudgeTimer = null, nudging = null;
  document.addEventListener("keydown", (e) => {
    if (!state.edit || !state.doc) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); (e.shiftKey ? redo : undo)(); return; }
    if (mod && e.key.toLowerCase() === "y" && !typing) { e.preventDefault(); redo(); return; }
    if (typing) return;
    if ((e.key === "Delete" || e.key === "Backspace") && state.selection.length) { e.preventDefault(); remove(state.selection); return; }
    if (e.key === "Escape" && state.selection.length) { state.selection = []; ctx.onSelect(); return; }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const block = state.selection.length === 1 ? state.selection[0] : null;
    if (arrows[e.key] && block?.bbox) {
      // Nudge by 1 pt (10 with Shift); the region is read again once the keys rest.
      e.preventDefault();
      const [dx, dy] = arrows[e.key].map((v) => v * (e.shiftKey ? 10 : 1));
      if (nudging !== block) { record(); nudging = block; }
      const page = pageOf(block);
      block.bbox = clamp([block.bbox[0] + dx, block.bbox[1] + dy, block.bbox[2] + dx, block.bbox[3] + dy], page);
      changed(block);
      ctx.onEdited([page.number]);
      ctx.onSelect();
      clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(() => { nudging = null; enqueue(async () => { await reread(block, page); ctx.onEdited([page.number]); ctx.onSelect(); }); }, 350);
    }
  });

  // ---------------------------------------------------------------- inspector
  let typingIn = null; // the block whose content is being typed (one undo step per field)
  function renderInspector(box) {
    const sel = state.selection;
    const undoButtons = `<div class="ed-history">
      <button type="button" class="btn small-btn" data-act="undo" ${undoStack.length ? "" : "disabled"} title="Ctrl+Z">↶ ${tr("edit.undo")}</button>
      <button type="button" class="btn small-btn" data-act="redo" ${redoStack.length ? "" : "disabled"} title="Ctrl+Shift+Z">↷ ${tr("edit.redo")}</button></div>`;
    if (!sel.length) {
      box.innerHTML = `<h3>${tr("edit.title")}</h3>${undoButtons}<p class="hint">${tr("edit.help")}</p><p class="hint">${tr("edit.exports")}</p>`;
      wire(box);
      return;
    }
    const b = sel[0];
    const typeOptions = ctx.types.map((t) => `<option value="${t}" ${sel.every((x) => x.type === t) ? "selected" : ""}>${esc(ctx.typeLabel(t))}</option>`).join("");
    const head = `<h3><span class="type-dot" style="--c:${ctx.typeColor(b.type)}"></span>${sel.length > 1 ? tr("edit.many", { n: sel.length }) : esc(ctx.typeLabel(b.type))}${b.edited ? ` <span class="ed-flag">${tr("edit.edited")}</span>` : ""}</h3>`;
    let fields = `<label class="ed-field"><span>${tr("edit.type")}</span><select data-act="type">${sel.length > 1 && !sel.every((x) => x.type === b.type) ? `<option value="" selected>—</option>` : ""}${typeOptions}</select></label>`;
    if (sel.length === 1) {
      if (b.type === "heading") {
        fields += `<label class="ed-field"><span>${tr("insp.level")}</span><select data-act="level">${[1, 2, 3, 4, 5, 6].map((n) => `<option ${b.level === n ? "selected" : ""}>${n}</option>`).join("")}</select></label>`;
      }
      const value = b.type === "table" ? (b.rows || []).map((r) => r.join(" | ")).join("\n") : b.type === "formula" ? b.latex || b.text || "" : b.text || "";
      const label = b.type === "table" ? tr("edit.cells") : b.type === "formula" ? "LaTeX" : tr("edit.text");
      fields += `<label class="ed-field ed-wide"><span>${label}</span><textarea data-act="content" rows="${Math.min(12, Math.max(3, value.split("\n").length + 1))}" spellcheck="false">${esc(value)}</textarea></label>`;
      if (b.type === "formula") fields += `<div class="ed-math" id="ed-math"></div>`;
      if (b.image?.data) fields += `<img class="ed-crop" alt="${tr("insp.crop")}" src="data:${b.image.mime};base64,${b.image.data}">`;
      fields += `<div class="kv"><span>id</span><b>${esc(b.id)}</b><span>bbox</span><b>${b.bbox ? b.bbox.map((v) => v.toFixed(1)).join(", ") : "—"}</b></div>`;
    }
    const actions = [
      sel.length > 1 ? `<button type="button" class="btn small-btn" data-act="merge">${tr("edit.merge", { n: sel.length })}</button>` : "",
      state.pdf ? `<button type="button" class="btn small-btn" data-act="reread" title="${esc(tr("edit.rereadHint"))}">${tr("edit.reread")}</button>` : "",
      sel.length === 1 ? `<button type="button" class="btn small-btn" data-act="up" title="${esc(tr("edit.upHint"))}">↑ ${tr("edit.up")}</button><button type="button" class="btn small-btn" data-act="down" title="${esc(tr("edit.downHint"))}">↓ ${tr("edit.down")}</button>` : "",
      `<button type="button" class="btn small-btn ed-danger" data-act="delete">${tr("edit.delete")}</button>`,
    ].join("");
    box.innerHTML = `${head}${undoButtons}<div class="ed-fields">${fields}</div><div class="ed-actions">${actions}</div>
      <section class="ed-live"><h4>${tr("edit.live", { n: pageOf(b)?.number ?? "" })}</h4><div class="ed-preview prose" id="ed-preview"></div></section>`;
    wire(box);
    renderPreview(box);
    if (b.type === "formula" && sel.length === 1) renderMath(box, b.latex || b.text || "");
  }

  function renderMath(box, tex) {
    const el = box.querySelector("#ed-math");
    if (el && window.katex) { try { window.katex.render(tex, el, { displayMode: true, throwOnError: false }); } catch { el.textContent = tex; } }
  }

  // The page being edited as Markdown, block by block, the selected ones marked.
  function renderPreview(box) {
    const el = box.querySelector("#ed-preview");
    const page = state.selection.length && pageOf(state.selection[0]);
    if (!el || !page) return;
    const ids = new Set(selectedIds());
    el.innerHTML = "";
    for (const b of page.blocks) {
      if (["header", "footer", "page_number"].includes(b.type)) continue;
      const md = blockMarkdown(b, "embed", ctx.mathMode());
      if (!md.trim()) continue;
      const part = document.createElement("div");
      part.className = "ed-part" + (ids.has(b.id) ? " on" : "");
      part.dataset.id = b.id;
      ctx.renderMd(part, md);
      part.addEventListener("click", () => { state.selection = [b]; ctx.onSelect(); });
      el.append(part);
    }
    el.querySelector(".ed-part.on")?.scrollIntoView({ block: "nearest" });
  }

  function wire(box) {
    const on = (act, ev, fn) => box.querySelector(`[data-act="${act}"]`)?.addEventListener(ev, fn);
    on("undo", "click", undo);
    on("redo", "click", redo);
    on("type", "change", (e) => e.target.value && setType([...state.selection], e.target.value));
    on("level", "change", (e) => setLevel(state.selection[0], +e.target.value));
    on("merge", "click", () => merge([...state.selection]));
    on("delete", "click", () => remove([...state.selection]));
    on("reread", "click", rereadSelected);
    on("up", "click", () => shift(state.selection[0], -1));
    on("down", "click", () => shift(state.selection[0], 1));
    on("content", "input", (e) => {
      const b = state.selection[0];
      setContent(b, e.target.value, typingIn !== b);
      typingIn = b;
      if (b.type === "formula") renderMath(box, e.target.value);
      renderPreview(box);
    });
    on("content", "blur", () => { typingIn = null; });
  }

  return {
    renderInspector,
    undo,
    redo,
    get canUndo() { return undoStack.length > 0; },
    get dirty() { return undoStack.length > 0; },
    reset() { undoStack.length = 0; redoStack.length = 0; glyphCache.clear(); },
    HANDLES,
  };
}
