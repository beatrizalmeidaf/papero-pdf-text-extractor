// Layout editor, on the Compare view: the outline of every block sits over the PDF page and
// is dragged, resized, drawn, reclassified, merged, deleted or put elsewhere in the reading
// order right there; the papero output beside it follows while the pointer moves. Whenever a
// block's region changes, its content is read again from the PDF the same way the extraction
// reads it (engine.readRegion). A double click on the output fixes its text in place. Every
// other view and export works on the edited document.

import { cropRegion, pageGlyphs, readRegion } from "./engine.js";
import { esc } from "./export.js";
import { fillBlock, place } from "./compare.js";

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const MIN_SIZE = 4; // pt: a smaller box is a slip of the mouse
const DRAG_START = 3; // px before a press becomes a drag
const LIVE_EVERY = 90; // ms between two live readings while dragging
const CONTENT = ["text", "rows", "latex", "number", "marker", "runs"];
const IMAGE_TYPES = new Set(["figure", "table", "formula"]);
const round = (v) => Math.round(v * 100) / 100;

/**
 * @param {object} ctx
 *   state      the app state ({ doc, pdf, selection })
 *   list       the Compare view's page list (#diff-list)
 *   tr, types, typeLabel, toast
 *   isActive() is the Compare view on screen (keyboard shortcuts apply)
 *   onEdited(pageNumbers)  pages to draw again, views to refresh
 *   onSelect() the selection changed
 *   onHistory() undo/redo availability changed
 */
export function createEditor(ctx) {
  const { state, list, tr } = ctx;
  const undoStack = [], redoStack = [];
  const glyphCache = new Map(); // page number -> Promise(glyphs)
  const glyphReady = new Map(); // page number -> glyphs, once read (for live previews)
  let queue = Promise.resolve();
  let cropCount = 0;
  const reading = new Set(); // blocks being read again

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
  const select = (blocks) => { state.selection = blocks; ctx.onSelect(); decorate(); };
  const edited = (pages) => { ctx.onEdited(pages); ctx.onHistory?.(); decorate(); };

  // Work that reads the PDF is done one step at a time, in order.
  function enqueue(job) {
    queue = queue.then(job).catch((e) => { console.error(e); ctx.toast(e.message || String(e), true); });
    return queue;
  }

  // ---------------------------------------------------------------- history
  const snapshot = () => ({ pages: state.doc.pages.map((p) => p.blocks.map((b) => ({ ...b }))), selection: selectedIds() });
  function record() {
    undoStack.push(snapshot());
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
    ctx.onHistory?.();
  }
  function travel(from, to) {
    const step = from.pop();
    if (!step) return;
    to.push(snapshot());
    state.doc.pages.forEach((p, i) => { p.blocks = step.pages[i].map((b) => ({ ...b })); });
    selectIds(step.selection);
    edited(state.doc.pages.map((p) => p.number));
    ctx.onSelect();
  }
  const undo = () => enqueue(() => travel(undoStack, redoStack));
  const redo = () => enqueue(() => travel(redoStack, undoStack));

  // ---------------------------------------------------------------- reading the PDF again
  function glyphsOf(number) {
    if (!state.pdf) return Promise.resolve(null);
    if (!glyphCache.has(number)) {
      glyphCache.set(number, pageGlyphs(state.pdf, number).then((g) => { glyphReady.set(number, g); return g; }).catch(() => null));
    }
    return glyphCache.get(number);
  }

  async function reread(block, page) {
    reading.add(block);
    decorate();
    try {
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
    } finally {
      reading.delete(block);
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
  function clamp(bbox, page) {
    let [x0, y0, x1, y1] = bbox;
    if (x1 < x0) [x0, x1] = [x1, x0];
    if (y1 < y0) [y0, y1] = [y1, y0];
    return [Math.max(0, x0), Math.max(0, y0), Math.min(page.width, x1), Math.min(page.height, y1)].map(round);
  }

  function setGeometry(block, bbox) {
    const page = pageOf(block);
    record();
    block.bbox = clamp(bbox, page);
    block.edited = true;
    edited([page.number]);
    return enqueue(async () => { await reread(block, page); edited([page.number]); });
  }

  function setType(blocks, type) {
    record();
    const pages = new Set(blocks.map(pageOf));
    for (const b of blocks) {
      b.type = type;
      if (type === "heading") b.level = b.level && b.level <= 6 ? b.level : 2;
      b.edited = true;
    }
    edited([...pages].map((p) => p.number));
    return enqueue(async () => {
      for (const b of blocks) {
        const page = pageOf(b);
        if (page && b.bbox) await reread(b, page);
        else convertWithoutPdf(b);
      }
      edited([...pages].map((p) => p.number));
      ctx.onSelect();
    });
  }

  function setLevel(block, level) {
    record();
    block.level = level;
    block.edited = true;
    edited([pageOf(block).number]);
  }

  // Typed content: text, LaTeX, or table rows ("a | b" per line).
  function setContent(block, value) {
    record();
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
    block.edited = true;
    edited([pageOf(block).number]);
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
    edited([...pages].map((p) => p.number));
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
    first.bbox = [0, 1, 2, 3].map((k) => (k < 2 ? Math.min : Math.max)(...parts.map((b) => b.bbox[k]))).map(round);
    if (!IMAGE_TYPES.has(first.type)) {
      first.text = parts.map((b) => (b.rows ? b.rows.map((r) => r.join(" ")).join(" ") : b.text || "").trim()).filter(Boolean).join(" ");
      if (parts.some((b) => b.runs)) {
        first.runs = parts.flatMap((b, i) => [
          ...(i ? [{ text: " ", bold: false, italic: false, script: null }] : []),
          ...(b.runs || [{ text: (b.text || "").trim(), bold: false, italic: false, script: null }]),
        ]);
      } else delete first.runs;
      delete first.line_boxes;
    }
    first.edited = true;
    page.blocks = page.blocks.filter((b) => !rest.includes(b));
    renumber(page);
    state.selection = [first];
    edited([page.number]);
    ctx.onSelect();
    if (IMAGE_TYPES.has(first.type)) return enqueue(async () => { await reread(first, page); edited([page.number]); });
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
    edited([page.number]);
    ctx.onSelect();
    return enqueue(async () => {
      await reread(block, page);
      if (/^\s*([•◦▪‣●○■□–—*-]|\(?\d{1,3}[.)]|\(?[a-z][.)])\s/.test(block.text || "")) {
        block.type = "list_item"; // a marker opens it
        await reread(block, page);
      }
      edited([page.number]);
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
    block.edited = true;
    edited([page.number]);
    ctx.onSelect();
  }

  function rereadSelected() {
    const blocks = state.selection.filter((b) => b.bbox);
    if (!blocks.length) return;
    record();
    return enqueue(async () => {
      for (const b of blocks) await reread(b, pageOf(b));
      edited([...new Set(blocks.map((b) => pageOf(b).number))]);
    });
  }

  // ---------------------------------------------------------------- looks: selection, handles, toolbar
  const rowOf = (n) => list.querySelector(`.diff-row[data-page="${n}"]`);
  const outlineOf = (b) => list.querySelector(`.diff-pane.original .ob[data-id="${b.id}"]`);
  const outputOf = (b) => list.querySelector(`.diff-pane.output .rb[data-id="${b.id}"]`);

  function decorate() {
    if (!state.doc) return;
    const ids = new Set(selectedIds());
    list.querySelectorAll(".handle, .ed-bar").forEach((el) => el.remove());
    list.querySelectorAll(".ob, .rb").forEach((el) => {
      el.classList.toggle("sel", ids.has(el.dataset.id));
      el.classList.toggle("reading", [...reading].some((b) => b.id === el.dataset.id));
    });
    if (state.selection.length === 1) {
      const ob = outlineOf(state.selection[0]);
      ob?.insertAdjacentHTML("beforeend", HANDLES.map((h) => `<i class="handle" data-h="${h}"></i>`).join(""));
    }
    toolbar();
  }

  // The tools for the selection, floating over the page, right above its first block.
  function toolbar() {
    const sel = state.selection;
    if (!sel.length) return;
    const b = sel[0];
    const ob = outlineOf(b);
    const panes = ob?.closest(".diff-panes");
    if (!ob || !panes) return;
    const sameType = sel.every((x) => x.type === b.type);
    const bar = document.createElement("div");
    bar.className = "ed-bar";
    bar.innerHTML = `
      <select data-act="type" title="${esc(tr("edit.type"))}" aria-label="${esc(tr("edit.type"))}">
        ${sameType ? "" : `<option value="" selected>${esc(tr("edit.many", { n: sel.length }))}</option>`}
        ${ctx.types.map((t) => `<option value="${t}" ${sameType && b.type === t ? "selected" : ""}>${esc(ctx.typeLabel(t))}</option>`).join("")}
      </select>
      ${sel.length === 1 && b.type === "heading" ? `<select data-act="level" title="${esc(tr("insp.level"))}" aria-label="${esc(tr("insp.level"))}">${[1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${b.level === n ? "selected" : ""}>H${n}</option>`).join("")}</select>` : ""}
      ${sel.length > 1 ? `<button type="button" data-act="merge" title="${esc(tr("edit.mergeHint"))}">${icon("merge")}<span>${esc(tr("edit.merge", { n: sel.length }))}</span></button>` : ""}
      ${sel.length === 1 && b.type !== "figure" ? `<button type="button" data-act="text" title="${esc(tr("edit.textHint"))}">${icon("text")}<span>${esc(tr("edit.text"))}</span></button>` : ""}
      ${state.pdf ? `<button type="button" data-act="reread" title="${esc(tr("edit.rereadHint"))}">${icon("reread")}</button>` : ""}
      ${sel.length === 1 ? `<button type="button" data-act="up" title="${esc(tr("edit.upHint"))}">${icon("up")}</button><button type="button" data-act="down" title="${esc(tr("edit.downHint"))}">${icon("down")}</button>` : ""}
      <button type="button" data-act="delete" class="danger" title="${esc(tr("edit.deleteHint"))}">${icon("delete")}</button>`;
    panes.append(bar);
    // Above the block when there is room, below otherwise; never off the page sideways.
    const r = ob.getBoundingClientRect(), p = panes.getBoundingClientRect();
    const h = bar.offsetHeight, w = bar.offsetWidth;
    const top = r.top - p.top - h - 8 >= 0 ? r.top - p.top - h - 8 : r.bottom - p.top + 8;
    bar.style.top = `${top}px`;
    bar.style.left = `${Math.max(0, Math.min(r.left - p.left, p.width - w))}px`;
    const on = (act, ev, fn) => bar.querySelector(`[data-act="${act}"]`)?.addEventListener(ev, fn);
    bar.addEventListener("pointerdown", (e) => e.stopPropagation());
    on("type", "change", (e) => e.target.value && setType([...sel], e.target.value));
    on("level", "change", (e) => setLevel(b, +e.target.value));
    on("merge", "click", () => merge([...sel]));
    on("text", "click", () => editText(b));
    on("reread", "click", rereadSelected);
    on("up", "click", () => shift(b, -1));
    on("down", "click", () => shift(b, 1));
    on("delete", "click", () => remove([...sel]));
  }

  // ---------------------------------------------------------------- the text, fixed in place
  function editText(block, cell = null) {
    const rb = outputOf(block);
    if (!rb || block.type === "figure") return;
    const body = rb.querySelector(".rb-body");
    rb.classList.add("editing");
    const done = (keep) => {
      target.removeEventListener("keydown", onKey);
      target.removeEventListener("blur", onBlur);
      target.contentEditable = "false";
      rb.classList.remove("editing");
      if (!keep) { edited([pageOf(block).number]); return; }
      if (block.type === "table") {
        const rows = [...rb.querySelectorAll("tr")].map((tr_) => [...tr_.cells].map((c) => c.textContent.trim()));
        setContent(block, rows.map((r) => r.join(" | ")).join("\n"));
      } else {
        const value = target.innerText.replace(/\n$/, "");
        if (value !== original) setContent(block, value);
        else edited([pageOf(block).number]);
      }
    };
    let target = body, original;
    if (block.type === "table") {
      target = cell || rb.querySelector("td");
      if (!target) return;
      original = target.textContent;
    } else {
      original = block.type === "formula" ? block.latex || block.text || "" : block.text || "";
      body.textContent = original; // the bare text: no marker, no rendered math
    }
    try { target.contentEditable = "plaintext-only"; } catch { target.contentEditable = "true"; }
    if (target.contentEditable !== "plaintext-only") target.contentEditable = "true";
    target.focus();
    const range = document.createRange();
    range.selectNodeContents(target);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); done(false); }
      else if (e.key === "Enter" && !e.shiftKey && block.type !== "code") { e.preventDefault(); target.blur(); }
    };
    const onBlur = () => done(true);
    target.addEventListener("keydown", onKey);
    target.addEventListener("blur", onBlur);
  }

  // ---------------------------------------------------------------- pointer
  let live = 0;
  // While a block is being moved or drawn, its output beside follows: the same place, and
  // the content the region holds right now (read from the glyphs already at hand).
  function preview(rb, block, bbox, page, scale) {
    place(rb, bbox, scale);
    const glyphs = glyphReady.get(page.number);
    if (!glyphs || block.type === "figure" || performance.now() - live < LIVE_EVERY) return;
    live = performance.now();
    fillBlock(rb, { ...block, ...readRegion(glyphs, clamp(bbox, page), block.type), bbox }, scale, ctx.typeLabel);
  }

  list.addEventListener("pointerdown", (e) => {
    if (!state.doc || e.button !== 0) return;
    const rb = e.target.closest(".diff-pane.output .rb");
    if (rb) { // the output: pick (Shift adds); a double click edits the text
      if (rb.classList.contains("editing")) return;
      const block = pageNumbered(+rb.closest(".diff-pane").dataset.page)?.blocks.find((b) => b.id === rb.dataset.id);
      if (block) select(e.shiftKey ? toggle(block) : [block]);
      return;
    }
    const pane = e.target.closest(".diff-pane.original");
    if (!pane) return;
    const page = pageNumbered(+pane.dataset.page);
    if (!page?.width) return;
    glyphsOf(page.number); // so that the live preview has them
    const scale = +pane.dataset.scale;
    const row = pane.closest(".diff-row");
    const rect = pane.getBoundingClientRect();
    const at = (ev) => [(ev.clientX - rect.left) / scale, (ev.clientY - rect.top) / scale];
    const start = at(e);
    const handle = e.target.closest(".handle")?.dataset.h;
    const ob = e.target.closest(".ob");
    const block = ob && page.blocks.find((b) => b.id === ob.dataset.id);
    e.preventDefault();
    if (block && e.shiftKey && !handle) { select(toggle(block)); return; }
    if (block && (!state.selection.includes(block) || state.selection.length > 1)) select([block]);
    if (!block && state.selection.length) select([]);
    const mode = block ? (handle ? "resize" : "move") : "draw";
    const origin = block ? [...block.bbox] : null;
    const output = block ? outputOf(block) : null;
    let ghost = null, twin = null, moved = false, last = e;
    pane.setPointerCapture(e.pointerId);

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
    const onMove = (ev) => {
      last = ev;
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < DRAG_START) return;
      if (!moved) {
        moved = true;
        row.classList.add("dragging");
        list.querySelectorAll(".ed-bar").forEach((el) => el.remove());
        if (mode === "draw") {
          ghost = Object.assign(document.createElement("div"), { className: "ob drawing" });
          twin = Object.assign(document.createElement("div"), { className: "rb drawing" });
          twin.style.setProperty("--c", "var(--accent)");
          pane.append(ghost);
          row.querySelector(".diff-pane.output").append(twin);
        } else {
          ob.classList.add("moving");
          output?.classList.add("moving");
        }
      }
      const box = target();
      place(ghost || ob, box, scale);
      const shown = twin || output;
      if (shown) preview(shown, block || { type: "paragraph" }, box, page, scale);
    };
    const onUp = () => {
      pane.removeEventListener("pointermove", onMove);
      pane.removeEventListener("pointerup", onUp);
      pane.removeEventListener("pointercancel", onUp);
      row.classList.remove("dragging");
      ghost?.remove();
      twin?.remove();
      ob?.classList.remove("moving");
      output?.classList.remove("moving");
      if (!moved) { decorate(); return; }
      const [x0, y0, x1, y1] = target();
      const big = Math.abs(x1 - x0) >= MIN_SIZE && Math.abs(y1 - y0) >= MIN_SIZE;
      if (mode === "draw") { if (big) add(page, [x0, y0, x1, y1]); return; }
      if (!big || (x0 === origin[0] && y0 === origin[1] && x1 === origin[2] && y1 === origin[3])) { edited([page.number]); return; }
      setGeometry(block, [x0, y0, x1, y1]);
    };
    pane.addEventListener("pointermove", onMove);
    pane.addEventListener("pointerup", onUp);
    pane.addEventListener("pointercancel", onUp);
  });
  const toggle = (block) => (state.selection.includes(block) ? state.selection.filter((b) => b !== block) : [...state.selection, block]);

  list.addEventListener("dblclick", (e) => {
    const rb = e.target.closest(".diff-pane.output .rb");
    const ob = e.target.closest(".diff-pane.original .ob");
    const el = rb || ob;
    if (!el || !state.doc) return;
    const block = pageNumbered(+el.closest(".diff-pane").dataset.page)?.blocks.find((b) => b.id === el.dataset.id);
    if (!block) return;
    e.preventDefault();
    select([block]);
    editText(block, rb ? e.target.closest("td") : null);
  });

  // Hovering a block lights up its other half.
  list.addEventListener("pointerover", (e) => {
    const el = e.target.closest(".ob, .rb");
    list.querySelectorAll(".hot").forEach((x) => x.classList.remove("hot"));
    if (!el?.dataset.id) return;
    const row = el.closest(".diff-row");
    row?.querySelectorAll(`[data-id="${el.dataset.id}"]`).forEach((x) => x.classList.add("hot"));
  });

  // ---------------------------------------------------------------- keyboard
  let nudgeTimer = null, nudging = null;
  document.addEventListener("keydown", (e) => {
    if (!state.doc || !ctx.isActive()) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (typing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); (e.shiftKey ? redo : undo)(); return; }
    if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
    if ((e.key === "Delete" || e.key === "Backspace") && state.selection.length) { e.preventDefault(); remove([...state.selection]); return; }
    if (e.key === "Escape" && state.selection.length) { select([]); return; }
    if (e.key === "Enter" && state.selection.length === 1) { e.preventDefault(); editText(state.selection[0]); return; }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const block = state.selection.length === 1 ? state.selection[0] : null;
    if (arrows[e.key] && block?.bbox) {
      // Nudge by 1 pt (10 with Shift); the region is read again once the keys rest.
      e.preventDefault();
      const [dx, dy] = arrows[e.key].map((v) => v * (e.shiftKey ? 10 : 1));
      if (nudging !== block) { record(); nudging = block; }
      const page = pageOf(block);
      block.bbox = clamp([block.bbox[0] + dx, block.bbox[1] + dy, block.bbox[2] + dx, block.bbox[3] + dy], page);
      block.edited = true;
      edited([page.number]);
      clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(() => { nudging = null; enqueue(async () => { await reread(block, page); edited([page.number]); }); }, 350);
    }
  });

  return {
    decorate,
    undo,
    redo,
    get canUndo() { return undoStack.length > 0; },
    get canRedo() { return redoStack.length > 0; },
    get dirty() { return undoStack.length > 0; },
    reset() { undoStack.length = 0; redoStack.length = 0; glyphCache.clear(); glyphReady.clear(); ctx.onHistory?.(); },
  };
}

// Small line icons for the toolbar.
function icon(name) {
  const paths = {
    merge: '<path d="M8 6h8M8 12h8M8 18h8"/><path d="M4 6v12"/>',
    text: '<path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/>',
    reread: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
    up: '<path d="m6 15 6-6 6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    delete: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
