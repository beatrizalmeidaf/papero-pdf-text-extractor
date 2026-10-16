// Compare view: each page of the PDF next to what was extracted from it, drawn
// block by block in the same place — so a table that came out as text, a formula that came
// out empty or a paragraph that is missing is seen at a glance. On the PDF side, the text
// that is not in the output is marked and every block is outlined (the layout editor moves
// and resizes those outlines); on the output side, the blocks that failed a check.

import { esc } from "./export.js";
import { SIGNALS } from "./fidelity.js";

const FURNITURE = new Set(["header", "footer", "page_number"]);
const ERRORS = new Set(["table_not_detected", "text_loss", "no_text"]);
const pct = (score) => (score == null ? "—" : `${(score * 100).toFixed(1)}%`);
export const typeColor = (t) => `var(--t-${FURNITURE.has(t) ? "furniture" : t})`;

// ---------------------------------------------------------------- fidelity panel
export function renderFidelity(box, fidelity, { tr, hasReference, onPage }) {
  const code = (c) => (tr(`fid.code.${c}`) === `fid.code.${c}` ? c : tr(`fid.code.${c}`));
  const signals = SIGNALS.map((name) => {
    const s = fidelity.signals[name];
    const detail = s.total ? `${Math.round(s.ok).toLocaleString()} / ${Math.round(s.total).toLocaleString()}` : tr("fid.sig.none");
    return `<div class="fid-signal"><span>${tr(`fid.sig.${name}`)}</span>
      <div class="meter"><i style="width:${s.score == null ? 0 : (s.score * 100).toFixed(1)}%"></i></div>
      <b>${pct(s.score)}</b><small>${detail}</small></div>`;
  }).join("");
  const issues = fidelity.issues.map((i) => `<li class="${i.severity}"><span class="badge">${tr(`fid.sev.${i.severity}`)}</span>
      <span>${esc(code(i.code))} <span class="times">×${i.count}</span></span>
      <span class="fid-pages">${i.pages.map((p) => `<button type="button" data-page="${p}">p. ${p}</button>`).join("")}</span></li>`).join("");
  box.className = `fidelity ${fidelity.status}`;
  box.innerHTML = `
    <div class="fid-head"><b>${pct(fidelity.score)}</b>
      <div><strong>${tr("fid.title")}</strong> <span class="badge">${tr(`fid.status.${fidelity.status}`)}</span>
      <p class="hint">${tr("fid.note")}${hasReference ? "" : " " + tr("fid.nopdf")}</p></div></div>
    <div class="fid-signals">${signals}</div>
    ${issues ? `<ul class="fid-issues">${issues}</ul>` : `<p class="hint">${tr("fid.none")}</p>`}`;
  box.querySelectorAll("button[data-page]").forEach((b) => b.addEventListener("click", () => onPage(+b.dataset.page)));
}

// ---------------------------------------------------------------- one block of the output
// Shrinks the type until the content fits its box: the page was set in another font.
export function fit(el) {
  let size = parseFloat(el.style.fontSize);
  for (let k = 0; k < 16 && size > 3 && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1); k++) {
    size *= 0.92;
    el.style.fontSize = `${size}px`;
    if (el.style.lineHeight.endsWith("px")) el.style.lineHeight = `${parseFloat(el.style.lineHeight) * 0.92}px`;
  }
}

// Where a block sits on a pane drawn at `scale`.
export function place(el, [x0, y0, x1, y1], scale) {
  el.style.left = `${Math.min(x0, x1) * scale}px`;
  el.style.top = `${Math.min(y0, y1) * scale}px`;
  el.style.width = `${Math.abs(x1 - x0) * scale}px`;
  el.style.height = `${Math.abs(y1 - y0) * scale}px`;
}

// The content of an output block (text, table, LaTeX, picture), sized to fit it.
export function fillBlock(el, b, scale, typeLabel) {
  el.querySelectorAll(":scope > :not(.rtag)").forEach((n) => n.remove());
  [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).forEach((n) => n.remove());
  el.style.fontSize = `${(b.style?.pt || b.style?.size || 9) * scale}px`;
  el.style.lineHeight = b.format?.leading ? `${b.format.leading * scale}px` : "1.2";
  el.classList.toggle("center", b.type === "formula" || (b.type === "figure" && !b.image?.data));
  el.classList.toggle("placeholder", b.type === "figure" && !b.image?.data);
  const body = document.createElement("div");
  body.className = "rb-body";
  if (b.type === "table" && b.rows) {
    body.innerHTML = `<table>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table>`;
  } else if (b.type === "formula") {
    if (b.latex && window.katex) {
      try { window.katex.render(b.latex, body, { displayMode: false, throwOnError: false }); } catch { body.textContent = b.text || ""; }
    } else body.textContent = b.text || "";
  } else if (b.type === "figure") {
    if (b.image?.data) body.innerHTML = `<img alt="" src="data:${b.image.mime};base64,${b.image.data}">`;
    else body.textContent = typeLabel("figure");
  } else {
    body.textContent = (b.type === "list_item" && b.marker ? `${b.marker} ` : "") + (b.text || "");
  }
  el.prepend(body);
  if (!body.querySelector("img")) fit(el);
}

function blockEl(b, scale, codes, { tr, typeLabel }) {
  const el = document.createElement("div");
  el.className = "rb" + (FURNITURE.has(b.type) ? " furniture" : "") + (b.edited ? " edited" : "");
  el.dataset.type = b.type;
  el.dataset.id = b.id;
  el.style.cssText = `--c:${typeColor(b.type)};`
    + (b.format?.align ? `text-align:${b.format.align};` : "")
    + (b.style?.font ? `font-family:"${b.style.font.replace(/[^\p{L}\p{N} -]/gu, "")}",Georgia,serif;` : "")
    + (b.style?.bold || b.type === "heading" ? "font-weight:650;" : "");
  place(el, b.bbox, scale);
  let title = typeLabel(b.type);
  if (codes?.length) {
    const error = codes.some((c) => ERRORS.has(c));
    el.classList.add("flagged", error ? "error" : "warning");
    title += " — " + codes.map((c) => tr(`fid.code.${c}`)).join("; ");
    const tag = document.createElement("span");
    tag.className = "rtag";
    tag.textContent = codes.map((c) => tr(`fid.tag.${c}`)).join(" · ");
    el.append(tag);
  }
  el.title = title;
  return el;
}

// The outline of a block over the PDF: what the layout editor drags.
function outlineEl(b, n, scale, typeLabel) {
  const el = document.createElement("div");
  el.className = "ob" + (b.edited ? " edited" : "");
  el.dataset.type = b.type;
  el.dataset.id = b.id;
  el.style.setProperty("--c", typeColor(b.type));
  place(el, b.bbox, scale);
  el.innerHTML = `<span class="ob-tag">${n + 1} · ${esc(typeLabel(b.type))}${b.type === "heading" && b.level ? " " + b.level : ""}</span>`;
  return el;
}

// ---------------------------------------------------------------- pages
let observer;

async function paintOriginal(pane, pdf, number, scale) {
  if (!pdf) return;
  const page = await pdf.getPage(number);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: scale * dpr, rotation: 0 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${viewport.width / dpr}px`;
  canvas.style.height = `${viewport.height / dpr}px`;
  pane.prepend(canvas);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
}

// Outlines, missing-text marks and output blocks of a page: drawn again after each edit.
function paintBlocks(row, page, mark, ctx) {
  const scale = +row.dataset.scale;
  const [original, output] = row.querySelectorAll(".diff-pane");
  original.querySelectorAll(".miss, .ob").forEach((el) => el.remove());
  output.querySelectorAll(".rb").forEach((el) => el.remove());
  for (const [x0, y0, x1, y1] of mark.missing) {
    const m = document.createElement("i");
    m.className = "miss";
    m.style.cssText = `left:${x0 * scale - 1}px;top:${y0 * scale - 1}px;width:${(x1 - x0) * scale + 2}px;height:${(y1 - y0) * scale + 2}px`;
    original.append(m);
  }
  const placed = page.blocks.filter((b) => b.bbox);
  original.append(...placed.map((b) => outlineEl(b, page.blocks.indexOf(b), scale, ctx.typeLabel)));
  const els = placed.map((b) => blockEl(b, scale, mark.flags.get(b.id), ctx));
  output.append(...els);
  els.forEach((el, k) => fillBlock(el, placed[k], scale, ctx.typeLabel));
  const notes = [
    mark.missing.length ? `<span class="error">${ctx.tr("diff.missing", { n: mark.missing.length })}</span>` : "",
    mark.flags.size ? `<span class="warning">${ctx.tr("diff.flags", { n: mark.flags.size })}</span>` : "",
  ].join("");
  row.querySelector("header").innerHTML = `<b>p. ${page.number}</b>${notes}`;
  ctx.onPainted?.(row);
}

const markOf = (fidelity, n) => fidelity.pages.get(n) || { missing: [], flags: new Map() };

export function renderCompare(list, ctx) {
  const { doc, pdf, fidelity, onlyProblems, tr } = ctx;
  observer?.disconnect();
  list.innerHTML = "";
  const avail = (list.clientWidth || 800) - 18; // room for the scrollbar the pages bring in
  const side = avail >= 640; // narrower than that, the output goes under its page
  const paneWidth = side ? (avail - 16) / 2 : Math.min(avail, 900);
  const jobs = new Map();
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { observer.unobserve(e.target); jobs.get(e.target)?.(); }
  }, { rootMargin: "400px" });

  let shown = 0;
  for (const page of doc.pages) {
    if (!page.width) continue;
    const mark = markOf(fidelity, page.number);
    if (onlyProblems && !(mark.missing.length + mark.flags.size)) continue;
    shown++;
    const scale = paneWidth / page.width;
    const size = `width:${paneWidth}px;height:${page.height * scale}px`;
    const row = document.createElement("section");
    row.className = "diff-row";
    row.dataset.page = page.number;
    row.dataset.scale = scale;
    row.innerHTML = `<header><b>p. ${page.number}</b></header>
      <div class="diff-panes${side ? " two" : ""}">
        <figure><figcaption>${tr("diff.original")}</figcaption><div class="diff-pane original" data-page="${page.number}" data-scale="${scale}" style="${size}"></div></figure>
        <figure><figcaption>${tr("diff.output")}</figcaption><div class="diff-pane output" data-page="${page.number}" data-scale="${scale}" style="${size}"></div></figure>
      </div>`;
    jobs.set(row, () => {
      row.dataset.painted = "1";
      paintBlocks(row, page, mark, ctx);
      paintOriginal(row.querySelector(".diff-pane.original"), pdf, page.number, scale);
    });
    list.append(row);
    observer.observe(row);
  }
  if (!shown) list.innerHTML = `<p class="hint">${tr(onlyProblems ? "diff.empty" : "no.positions")}</p>`;
}

// One page drawn again (its picture stays) after an edit.
export function refreshComparePage(list, page, ctx) {
  const row = list.querySelector(`.diff-row[data-page="${page.number}"]`);
  if (row?.dataset.painted) paintBlocks(row, page, markOf(ctx.fidelity, page.number), ctx);
}
