import { renderCompare, renderFidelity } from "./compare.js";
import { createEditor } from "./editor.js";
import { captionText, extractDocument, openPdf } from "./engine.js";
import { assess, referenceItems } from "./fidelity.js";
import { applyStatic, lang, setLang, t as tr } from "./i18n.js";
import { FORMATS, esc, exportAs, imagesOf, tablesCsv, tablesOf, toJson, toMarkdown, toText } from "./export.js";

const $ = (s) => document.querySelector(s);
const TYPES = ["heading", "paragraph", "list_item", "table", "figure", "formula", "caption", "code", "header", "footer", "page_number"];
const TYPE_LABEL = new Proxy({}, { get: (_, type) => (TYPES.includes(type) ? tr(`type.${type}`) : undefined) });
const typeColor = (t) => `var(--t-${["header", "footer", "page_number"].includes(t) ? "furniture" : t})`;
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const state = {
  file: null, data: null, doc: null, pdf: null, hidden: new Set(["header", "footer", "page_number"]), selected: null,
  fidelity: null, hasReference: false, reference: null, diffDirty: false,
  edit: false, selection: [], // layout editor: on/off, the selected blocks
};

// ---------------------------------------------------------------- small UI helpers
let toastTimer;
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast on" + (err ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), err ? 6000 : 2500);
}
function setProgress(frac) {
  const p = $("#progress");
  p.classList.toggle("on", frac !== null);
  p.firstElementChild.style.width = `${Math.round((frac ?? 0) * 100)}%`;
}
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const stem = () => (state.file?.name || "documento").replace(/\.[^.]+$/, "") || "documento";
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

// ---------------------------------------------------------------- theme
$("#theme-btn").addEventListener("click", () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  store.set("pte-theme", root.dataset.theme);
});

// ---------------------------------------------------------------- engine choice
const engineInputs = document.querySelectorAll('input[name="engine"]');
const serverUrl = $("#server-url");
function engine() { return document.querySelector('input[name="engine"]:checked').value; }
function syncEngine() {
  const server = engine() === "server";
  $("#server-field").hidden = !server;
  $("#engine-hint").textContent = tr(server ? "engine.hint.server" : "engine.hint.browser");
  $("#privacy-text").textContent = tr(server ? "privacy.server" : "privacy.browser");
  $("#file").accept = server ? "" : "application/pdf,.pdf";
  $("#drop strong").textContent = tr(server ? "drop.doc" : "drop.pdf");
  store.set("pte-engine", engine());
}
engineInputs.forEach((i) => i.addEventListener("change", syncEngine));
serverUrl.value = store.get("pte-server", "");
serverUrl.addEventListener("change", () => store.set("pte-server", serverUrl.value.trim()));

(async function detectServer() {
  // Served by the API itself? Then default to it (same origin, Tika available).
  const saved = store.get("pte-engine", null);
  if (document.documentElement.dataset.api === "same-origin") {
    try {
      const r = await fetch(`${location.origin}/health`, { cache: "no-store" });
      if (r.ok && (await r.json()).status === "ok") {
        if (!serverUrl.value) serverUrl.value = location.origin;
        if (saved !== "browser") document.querySelector('input[value="server"]').checked = true;
      }
    } catch { /* static hosting */ }
  } else if (saved === "server" && serverUrl.value) {
    document.querySelector('input[value="server"]').checked = true;
  }
  syncEngine();
})();

// ---------------------------------------------------------------- file input
const drop = $("#drop");
const fileInput = $("#file");
drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => e.dataTransfer.files[0] && setFile(e.dataTransfer.files[0]));
fileInput.addEventListener("change", () => fileInput.files[0] && setFile(fileInput.files[0]));
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });

async function setFile(file) {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf && engine() === "browser") {
    toast(tr("toast.onlyPdf"), true);
    return;
  }
  state.file = file;
  state.data = await file.arrayBuffer();
  $("#file-name").textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} KB`;
  $("#run-btn").disabled = false;
  run();
}

$("#sample-btn").addEventListener("click", async () => {
  try {
    const r = await fetch("assets/exemplo.pdf");
    const blob = await r.blob();
    await setFile(new File([blob], "exemplo.pdf", { type: "application/pdf" }));
  } catch {
    toast(tr("toast.sample"), true);
  }
});

// ---------------------------------------------------------------- extraction
$("#run-btn").addEventListener("click", run);
["opt-tables", "opt-formulas", "opt-images"].forEach((id) => $("#" + id).addEventListener("change", () => state.data && run()));

// How the math inside paragraphs is written in Markdown and text; no need to extract again.
const mathOpt = $("#opt-math");
mathOpt.checked = store.get("pte-math", "unicode") === "latex";
const mathMode = () => (mathOpt.checked ? "latex" : "unicode");
mathOpt.addEventListener("change", () => {
  store.set("pte-math", mathMode());
  if (!state.doc) return;
  renderMarkdown();
  $("#text-out").textContent = toText(state.doc, { math: mathMode() });
});

let running = false;
async function run() {
  if (!state.data || running) return;
  running = true;
  const btn = $("#run-btn");
  btn.disabled = true;
  setProgress(0.02);
  const opts = {
    pages: $("#pages").value.trim() || undefined,
    password: $("#password").value || undefined,
    tables: $("#opt-tables").checked,
    formulas: $("#opt-formulas").checked,
    images: $("#opt-images").checked,
  };
  try {
    const isPdf = state.file.type === "application/pdf" || /\.pdf$/i.test(state.file.name);
    let doc;
    if (engine() === "server") {
      doc = await extractOnServer(opts);
      state.pdf = isPdf ? await openPdf(state.data.slice(0), opts.password).catch(() => null) : null;
    } else {
      const res = await extractDocument(state.data.slice(0), { ...opts, onProgress: (d, t) => setProgress(d / t) });
      doc = res.doc;
      state.pdf = res.pdf;
    }
    state.doc = doc;
    state.selected = null;
    state.selection = [];
    editor.reset();
    state.fidelity = await assessDocument(doc);
    render();
  } catch (e) {
    console.error(e);
    toast((e.code && tr(`err.${e.code}`) !== `err.${e.code}` ? tr(`err.${e.code}`) : e.message) || tr("toast.failed"), true);
  } finally {
    running = false;
    btn.disabled = false;
    setProgress(null);
  }
}

// The fidelity signals (fidelity.js), against what pdf.js reads on each page when there is a PDF.
async function assessDocument(doc) {
  let reference = null;
  if (state.pdf) {
    try { reference = await referenceItems(state.pdf, doc.pages.map((p) => p.number)); } catch { /* structure only */ }
  }
  state.hasReference = !!reference;
  state.reference = reference;
  return assess(doc, reference, captionText);
}

async function extractOnServer(opts) {
  const base = (serverUrl.value.trim() || location.origin).replace(/\/+$/, "");
  const q = new URLSearchParams({ per_page: "true", images: String(opts.images), tables: String(opts.tables), formulas: String(opts.formulas) });
  if (opts.pages) q.set("pages", opts.pages);
  const form = new FormData();
  form.append("file", state.file);
  if (opts.password) form.append("password", opts.password);
  setProgress(0.3);
  let r;
  try {
    r = await fetch(`${base}/v1/extract?${q}`, { method: "POST", body: form });
  } catch {
    throw new Error(tr("toast.server", { url: base }));
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.message || tr("toast.apiError", { status: r.status }));
  setProgress(0.9);
  return body;
}

// ---------------------------------------------------------------- render
function render() {
  const doc = state.doc;
  const blocks = doc.pages.flatMap((p) => p.blocks);
  const tables = tablesOf(doc), images = imagesOf(doc);
  renderStats();
  $("#copy-btn").disabled = false;
  $("#export-btn").disabled = false;
  $("#empty").hidden = true;
  $("#viewer").hidden = false;
  renderLegend(blocks);
  renderPages();
  renderMarkdown();
  renderTables(tables);
  renderGallery(images);
  $("#text-out").textContent = toText(doc, { math: mathMode() });
  $("#json-out").textContent = toJson(doc, { embedImages: false });
  showInspector(null);
}

function renderStats() {
  const doc = state.doc;
  const blocks = doc.pages.flatMap((p) => p.blocks);
  const count = (t) => blocks.filter((b) => b.type === t).length;
  const tables = tablesOf(doc), images = imagesOf(doc);
  $("#n-tables").textContent = tables.length;
  $("#n-images").textContent = images.length;
  const stats = $("#stats");
  stats.hidden = false;
  const t = doc.timings || {};
  const f = state.fidelity;
  stats.innerHTML = [
    `<button type="button" class="fid-chip ${f.status}" id="fid-chip" title="${esc(tr("fid.note"))}">${tr("stats.fidelity")} <b>${f.score == null ? "—" : (f.score * 100).toFixed(1) + "%"}</b></button>`,
    `<span><b>${doc.pages_extracted ?? doc.pages.length}</b>/${doc.page_count} ${tr("stats.pages")}</span>`,
    `<span><b>${fmtMs(doc.elapsed_ms)}</b>${t.tika_ms ? ` (Tika ${fmtMs(t.tika_ms)} ‖ layout ${fmtMs(t.layout_ms)})` : ""}</span>`,
    `<span><b>${count("heading")}</b> ${tr("stats.headings")}</span>`,
    `<span><b>${tables.length}</b> ${tr("stats.tables")}</span>`,
    `<span><b>${count("figure")}</b> ${tr("stats.figures")}</span>`,
    `<span><b>${count("formula")}</b> ${tr("stats.formulas")}</span>`,
    `<span>${tr("stats.engine")}: <b>${esc(doc.engine)}</b></span>`,
    doc.likely_scanned ? `<span class="warn">${tr("stats.scanned")}</span>` : "",
    ...(doc.warnings || []).map((w) => `<span class="warn">${esc(w.split(":")[0])}</span>`),
  ].join("");
  $("#fid-chip").addEventListener("click", () => switchTab("diff"));
  state.diffDirty = true;
  if (!$("#view-diff").hidden) renderDiff();
}

function renderLegend(blocks) {
  const present = [...new Set(blocks.map((b) => b.type))];
  const legend = $("#legend");
  legend.innerHTML = "";
  for (const t of TYPES.filter((x) => present.includes(x))) {
    const n = blocks.filter((b) => b.type === t).length;
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.type = "button";
    chip.style.setProperty("--c", typeColor(t));
    chip.setAttribute("aria-pressed", String(!state.hidden.has(t)));
    chip.innerHTML = `<i></i>${TYPE_LABEL[t]} <span style="color:var(--muted)">${n}</span>`;
    chip.addEventListener("click", () => {
      state.hidden.has(t) ? state.hidden.delete(t) : state.hidden.add(t);
      chip.setAttribute("aria-pressed", String(!state.hidden.has(t)));
      document.querySelectorAll(`.box[data-type="${t}"]`).forEach((el) => (el.hidden = state.hidden.has(t)));
    });
    legend.append(chip);
  }
}

let observer;
function renderPages() {
  const list = $("#pages-list");
  list.innerHTML = "";
  observer?.disconnect();
  const avail = Math.min(list.clientWidth || 800, 900);
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { observer.unobserve(e.target); paintPage(e.target); }
  }, { rootMargin: "400px" });
  for (const page of state.doc.pages) {
    const w = page.width || 595, h = page.height || 842;
    const scale = avail / w;
    const wrap = document.createElement("div");
    wrap.className = "page-wrap";
    wrap.style.width = `${w * scale}px`;
    wrap.style.height = `${h * scale}px`;
    wrap.dataset.page = page.number;
    wrap.dataset.scale = scale;
    wrap.innerHTML = `<span class="page-label">p. ${page.number}</span>`;
    paintBoxes(wrap, page);
    list.append(wrap);
    observer.observe(wrap);
  }
  if (!state.doc.pages.some((p) => p.width)) {
    list.innerHTML = `<p class="hint">${tr("no.positions")}</p>`;
  }
  markSelection();
}

// The block outlines of one page (its drawing stays).
function paintBoxes(wrap, page) {
  wrap.querySelectorAll(".box").forEach((el) => el.remove());
  if (!page.width) return;
  const scale = parseFloat(wrap.dataset.scale);
  page.blocks.forEach((b, n) => {
    if (!b.bbox) return;
    const [x0, y0, x1, y1] = b.bbox;
    const el = document.createElement("button");
    el.type = "button";
    el.className = "box" + (b.edited ? " edited" : "");
    el.dataset.type = b.type;
    el.dataset.id = b.id;
    el.hidden = state.hidden.has(b.type);
    el.style.cssText = `--c:${typeColor(b.type)};left:${x0 * scale - 1}px;top:${y0 * scale}px;width:${(x1 - x0) * scale + 2}px;height:${(y1 - y0) * scale}px`;
    el.setAttribute("aria-label", `${TYPE_LABEL[b.type] || b.type}: ${(b.text || "").slice(0, 80)}`);
    el.innerHTML = `<span class="tag">${TYPE_LABEL[b.type] || b.type}${b.level ? " " + b.level : ""}</span><span class="order">${n + 1}</span>`;
    el.addEventListener("click", () => { if (!state.edit) select(b, el); });
    wrap.append(el);
  });
}

// Selected boxes marked; in the editor, the single selected one gets its resize handles.
function markSelection() {
  const ids = new Set(state.selection.map((b) => b.id));
  document.querySelectorAll("#pages-list .handle").forEach((h) => h.remove());
  document.querySelectorAll("#pages-list .box").forEach((el) => el.classList.toggle("sel", ids.has(el.dataset.id)));
  if (state.edit && state.selection.length === 1) {
    const el = document.querySelector(`#pages-list .box[data-id="${state.selection[0].id}"]`);
    if (el) {
      el.hidden = false;
      el.insertAdjacentHTML("beforeend", editor.HANDLES.map((h) => `<i class="handle" data-h="${h}"></i>`).join(""));
    }
  }
}

async function paintPage(wrap) {
  if (!state.pdf) return;
  const scale = parseFloat(wrap.dataset.scale);
  const page = await state.pdf.getPage(parseInt(wrap.dataset.page, 10));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: scale * dpr, rotation: 0 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${viewport.width / dpr}px`;
  canvas.style.height = `${viewport.height / dpr}px`;
  wrap.prepend(canvas);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
}

function select(block) {
  state.selection = block ? [block] : [];
  state.selected = block;
  markSelection();
  showInspector(block);
}

function showInspector(b) {
  const box = $("#inspector");
  if (state.edit) {
    editor.renderInspector(box);
    return;
  }
  if (!b) {
    box.innerHTML = `<h3>${tr("inspector.title")}</h3><p class="hint">${tr("inspector.hint")}</p>`;
    return;
  }
  let content = esc(b.text || "");
  if (b.type === "table" && b.rows) content = esc(b.rows.map((r) => r.join(" | ")).join("\n"));
  const extra = [
    b.level != null ? `<span>${tr("insp.level")}</span><b>${b.level}</b>` : "",
    b.marker ? `<span>${tr("insp.marker")}</span><b>${esc(b.marker)}</b>` : "",
    b.number ? `<span>${tr("insp.number")}</span><b>${esc(b.number)}</b>` : "",
    b.caption ? `<span>${tr("insp.caption")}</span><b>${esc(b.caption)}</b>` : "",
    b.style ? `<span>${tr("insp.font")}</span><b>${b.style.pt || b.style.size} pt${b.style.font ? " · " + esc(b.style.font) : ""}${b.style.bold ? " · " + tr("insp.bold") : ""}</b>` : "",
  ].join("");
  box.innerHTML = `
    <h3><span class="type-dot" style="--c:${typeColor(b.type)}"></span>${TYPE_LABEL[b.type] || b.type}</h3>
    <div class="kv"><span>id</span><b>${esc(b.id)}</b><span>bbox</span><b>${b.bbox ? b.bbox.map((v) => v.toFixed(1)).join(", ") : "—"}</b>${extra}</div>
    ${b.latex ? `<div class="kv"><span>LaTeX</span><b>${esc(b.latex)}</b></div><div id="insp-math"></div>` : ""}
    <pre>${content || `<em>${tr("insp.empty")}</em>`}</pre>
    ${b.image?.data ? `<img alt="${tr("insp.crop")}" src="data:${b.image.mime};base64,${b.image.data}">` : ""}`;
  if (b.latex && window.katex) {
    try { window.katex.render(b.latex, box.querySelector("#insp-math"), { displayMode: true, throwOnError: false }); } catch { /* keep text */ }
  }
}

function renderMarkdown() {
  const math = mathMode();
  $("#md-source").textContent = toMarkdown(state.doc, { images: "ref", math });
  renderMd($("#md-rendered"), toMarkdown(state.doc, { images: "embed", math }), math);
}

function renderMd(target, md, math = mathMode()) {
  if (window.marked && window.DOMPurify) {
    // $$…$$ blocks are swapped for placeholders so Markdown can't mangle the LaTeX
    // (a "_" would become italics), then KaTeX renders them after sanitizing.
    const formulas = [];
    let protectedMd = md.replace(/\$\$\n([\s\S]*?)\n\$\$/g, (_, tex) => {
      formulas.push(tex);
      return `<div class="math-ph" data-i="${formulas.length - 1}"></div>`;
    });
    // In LaTeX mode the math inside a paragraph is $…$ (and a literal dollar is "\$").
    if (math === "latex") {
      protectedMd = protectedMd.replace(/(?<!\\)\$([^$\n]+?)(?<!\\)\$/g, (_, tex) => {
        formulas.push(tex);
        return `<span class="math-ph" data-inline data-i="${formulas.length - 1}"></span>`;
      });
    }
    const html = window.marked.parse(protectedMd, { gfm: true, breaks: false });
    target.innerHTML = window.DOMPurify.sanitize(html);
    target.querySelectorAll(".math-ph").forEach((el) => {
      const tex = formulas[+el.dataset.i] ?? "";
      const inline = el.hasAttribute("data-inline");
      if (window.katex) window.katex.render(tex, el, { displayMode: !inline, throwOnError: false });
      else el.textContent = inline ? `$${tex}$` : `$$ ${tex} $$`;
    });
  } else {
    target.textContent = md;
  }
}
document.querySelectorAll('input[name="mdmode"]').forEach((i) =>
  i.addEventListener("change", () => {
    const src = i.value === "source" && i.checked;
    $("#md-source").hidden = !src;
    $("#md-rendered").hidden = src;
  }));

function renderTables(tables) {
  const list = $("#tables-list");
  if (!tables.length) {
    list.innerHTML = `<p class="hint">${tr("tables.none")}${$("#opt-tables").checked ? "" : tr("tables.off")}.</p>`;
    return;
  }
  list.innerHTML = "";
  tables.forEach((t, k) => {
    const card = document.createElement("div");
    card.className = "card";
    const page = t.id.split("-")[0].slice(1);
    const head = t.rows[0].map((c) => `<th>${esc(c)}</th>`).join("");
    const body = t.rows.slice(1).map((r) => `<tr>${r.map((c) => `<td>${esc(c).replace(/\n/g, "<br>")}</td>`).join("")}</tr>`).join("");
    card.innerHTML = `
      <header><b>${tr("tables.title")} ${k + 1}</b><span class="meta">p. ${page} · ${t.rows.length} × ${Math.max(...t.rows.map((r) => r.length))}${t.caption ? " · " + esc(t.caption) : ""}</span>
        <span class="spacer"></span>
        <button class="btn small-btn" data-act="copy" type="button">${tr("tables.copy")}</button>
        <button class="btn small-btn" data-act="show" type="button">${tr("tables.show")}</button></header>
      <div class="body"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
        ${t.image?.data ? `<img class="crop" alt="${tr("tables.crop")} ${k + 1}" src="data:${t.image.mime};base64,${t.image.data}">` : ""}</div>`;
    card.querySelector('[data-act="copy"]').addEventListener("click", async () => {
      const one = { ...state.doc, pages: [{ blocks: [t] }] };
      await navigator.clipboard.writeText(tablesCsv(one).split("\r\n").slice(1).join("\n"));
      toast(tr("toast.csv"));
    });
    card.querySelector('[data-act="show"]').addEventListener("click", () => jumpTo(t));
    list.append(card);
  });
}

function renderGallery(images) {
  const g = $("#gallery");
  if (!images.length) {
    g.innerHTML = `<p class="hint">${tr("images.none")}${$("#opt-images").checked ? "" : tr("images.off")}.</p>`;
    return;
  }
  g.innerHTML = "";
  for (const b of images) {
    const fig = document.createElement("figure");
    fig.innerHTML = `<div class="thumb"><img alt="${esc(TYPE_LABEL[b.type])} ${esc(b.caption || "")}" src="data:${b.image.mime};base64,${b.image.data}"></div>
      <figcaption><span class="type-dot" style="--c:${typeColor(b.type)}"></span><span title="${esc(b.caption || b.image.name)}">${esc(b.caption || b.image.name)}</span>
      <button class="btn small-btn" type="button">PNG</button></figcaption>`;
    fig.querySelector("button").addEventListener("click", async () => {
      const blob = await (await fetch(`data:${b.image.mime};base64,${b.image.data}`)).blob();
      download(blob, b.image.name);
    });
    fig.querySelector(".thumb").addEventListener("click", () => jumpTo(b));
    g.append(fig);
  }
}

// ---------------------------------------------------------------- compare (visual diff)
function renderDiff() {
  if (!state.doc) return;
  state.diffDirty = false;
  renderFidelity($("#fidelity"), state.fidelity, {
    tr,
    hasReference: state.hasReference,
    onPage: (n) => document.querySelector(`.diff-row[data-page="${n}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
  });
  renderCompare($("#diff-list"), {
    doc: state.doc,
    pdf: state.pdf,
    fidelity: state.fidelity,
    onlyProblems: $("#diff-only").checked,
    tr,
    typeLabel: (type) => TYPE_LABEL[type] || type,
    onSelect: jumpTo,
  });
}
$("#diff-only").addEventListener("change", renderDiff);

function jumpTo(block) {
  switchTab("pages");
  const el = document.querySelector(`.box[data-id="${block.id}"]`);
  if (el) {
    el.hidden = false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    select(block);
  }
}

// ---------------------------------------------------------------- layout editor
const editor = createEditor({
  state,
  list: $("#pages-list"),
  tr,
  types: TYPES,
  typeLabel: (type) => TYPE_LABEL[type] || type,
  typeColor,
  mathMode,
  toast,
  renderMd: (el, md) => renderMd(el, md),
  onSelect() {
    state.selected = state.selection[0] || null;
    markSelection();
    showInspector(state.selected);
  },
  onEdited(pageNumbers, { typing = false } = {}) {
    for (const n of pageNumbers) {
      const wrap = document.querySelector(`#pages-list .page-wrap[data-page="${n}"]`);
      const page = state.doc.pages.find((p) => p.number === n);
      if (wrap && page) paintBoxes(wrap, page);
    }
    markSelection();
    if (!typing) showInspector(state.selected);
    scheduleViews();
  },
  onBusy: (on) => $("#inspector").classList.toggle("busy", on),
});

// The other views follow the edits, a moment after the last one.
let viewsTimer;
function scheduleViews() {
  clearTimeout(viewsTimer);
  viewsTimer = setTimeout(() => {
    const doc = state.doc;
    state.fidelity = assess(doc, state.reference, captionText);
    renderStats();
    renderLegend(doc.pages.flatMap((p) => p.blocks));
    renderMarkdown();
    renderTables(tablesOf(doc));
    renderGallery(imagesOf(doc));
    $("#text-out").textContent = toText(doc, { math: mathMode() });
    $("#json-out").textContent = toJson(doc, { embedImages: false });
  }, 250);
}

const editBtn = $("#edit-btn");
function setEditing(on) {
  state.edit = on;
  editBtn.setAttribute("aria-pressed", String(on));
  editBtn.querySelector("span").textContent = tr(on ? "edit.done" : "edit.toggle");
  $("#pages-list").classList.toggle("editing", on);
  if (on) document.querySelectorAll("#pages-list .box").forEach((el) => (el.hidden = state.hidden.has(el.dataset.type)));
  markSelection();
  showInspector(state.selected);
}
editBtn.addEventListener("click", () => setEditing(!state.edit));
addEventListener("beforeunload", (e) => { if (editor.dirty) e.preventDefault(); });

// ---------------------------------------------------------------- tabs, copy, export
function switchTab(view) {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view)));
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
  if (view === "diff" && state.diffDirty) renderDiff();
}
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.view)));

$("#copy-btn").addEventListener("click", async () => {
  if (!state.doc) return;
  await navigator.clipboard.writeText(toMarkdown(state.doc, { images: "ref", math: mathMode() }));
  toast(tr("toast.md"));
});

const menu = $("#export-menu");
const list = $("#export-list");
function renderExportMenu() {
  list.innerHTML = FORMATS.map((f) => `<button role="menuitem" type="button" data-fmt="${f.id}"><span class="ext">.${f.ext}</span><span>${tr(`fmt.${f.id}`)}<small>${tr(`fmt.${f.id}.hint`)}</small></span></button>`).join("");
}
renderExportMenu();

// ---------------------------------------------------------------- language (pt / en)
const langBtn = $("#lang-btn");
const syncLangButton = () => (langBtn.textContent = lang === "pt" ? "EN" : "PT");
applyStatic();
syncLangButton();
syncEngine();
langBtn.addEventListener("click", () => {
  setLang(lang === "pt" ? "en" : "pt");
  syncLangButton();
  syncEngine();
  renderExportMenu();
  if (state.doc) render(); // re-label legend, stats, tables and inspector
  editBtn.querySelector("span").textContent = tr(state.edit ? "edit.done" : "edit.toggle");
});
$("#export-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = !menu.classList.contains("open");
  menu.classList.toggle("open", open);
  $("#export-btn").setAttribute("aria-expanded", String(open));
  if (open) list.querySelector("button").focus();
});
document.addEventListener("click", () => { menu.classList.remove("open"); $("#export-btn").setAttribute("aria-expanded", "false"); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") menu.classList.remove("open"); });
list.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-fmt]");
  if (!btn || !state.doc) return;
  const f = FORMATS.find((x) => x.id === btn.dataset.fmt);
  try {
    if ((f.id === "csv" || f.id === "xlsx") && !tablesOf(state.doc).length) toast(tr("toast.noTables"));
    if (!window.JSZip && ["xlsx", "docx", "zip"].includes(f.id)) throw new Error(tr("toast.zip"));
    const blob = await exportAs(state.doc, f.id, stem(), { math: mathMode() });
    download(blob, `${stem()}${f.id === "csv" ? "-tabelas" : ""}.${f.ext}`);
  } catch (err) {
    toast(err.message, true);
  }
});

// Re-fit the pages when the viewer width changes (rotation, window resize).
let lastWidth = 0;
let resizeTimer;
new ResizeObserver(([entry]) => {
  const w = Math.round(entry.contentRect.width);
  if (!state.doc || Math.abs(w - lastWidth) < 40) return;
  lastWidth = w;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    renderPages();
  }, 150);
}).observe($("#pages-list"));

let diffWidth = 0;
let diffTimer;
new ResizeObserver(([entry]) => {
  const w = Math.round(entry.contentRect.width);
  if (!state.doc || !w || Math.abs(w - diffWidth) < 40) return;
  const first = !diffWidth;
  diffWidth = w;
  if (first) return;
  clearTimeout(diffTimer);
  diffTimer = setTimeout(renderDiff, 150);
}).observe($("#diff-list"));
