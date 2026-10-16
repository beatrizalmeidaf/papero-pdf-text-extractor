// Runs web/assets/engine.js under Node and compares it with the Python engine's output
// (written by expected.py). Usage: python expected.py out && node parity.mjs out
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] || join(here, "out");
const src = readFileSync(join(here, "../../web/assets/engine.js"), "utf8")
  .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/pdfjs-dist@[\d.]+\/build\/pdf\.min\.mjs/, "pdfjs-dist/legacy/build/pdf.mjs")
  .replace(/pdfjsLib\.GlobalWorkerOptions\.workerSrc =\s*"[^"]+";/, "")
  .replace(/"\.\/(\w+\.js)"/g, (_, f) => JSON.stringify(pathToFileURL(join(here, "../../web/assets", f)).href));
const enginePath = join(here, ".engine.node.mjs");
writeFileSync(enginePath, src);
const { extractDocument, captionText, pageGlyphs, readRegion } = await import(pathToFileURL(enginePath).href);
const { assess, referenceItems } = await import(pathToFileURL(join(here, "../../web/assets/fidelity.js")).href);

// The fidelity report (web/assets/fidelity.js against fidelity.py): same verdict, same issues,
// same counts. The text signal reads the page with another library, so only its score is compared.
const verdict = (f) => ({
  status: f.status,
  issues: f.issues.map((i) => [i.code, i.severity, i.count, i.pages]),
  signals: Object.fromEntries(Object.entries(f.signals).map(([n, s]) => [n, n === "text" ? Math.round(s.score * 100) : [s.ok, s.total]])),
});

const view = (doc) =>
  doc.pages.map((p) =>
    p.blocks.map((b) => {
      const v = { type: b.type };
      if (b.rows) v.rows = b.rows;
      else if (b.type === "formula") v.latex = b.latex;
      else if (b.type !== "figure") v.text = b.text;
      if (b.level != null && b.type === "heading") v.level = b.level;
      return v;
    }));

let failures = 0;

// The inline-math writer (web/assets/mathtext.js against mathtext.py), sample by sample, and
// the Markdown and text it gives for each fixture.
const local = (f) => import(pathToFileURL(join(here, "../../web/assets", f)).href);
const { inlineLatex } = await local("mathtext.js");
const { toMarkdown, toText } = await local("export.js");
const same = (label, py, js) => {
  if (py === js) return true;
  failures++;
  console.error(`✗ ${label}\n  python: ${JSON.stringify(py)}\n  js:     ${JSON.stringify(js)}`);
  return false;
};
const samples = Object.entries(JSON.parse(readFileSync(join(dir, "inline_math.json"), "utf8")));
if (samples.map(([text, py]) => same(`inline math: ${text}`, py, inlineLatex(text))).every(Boolean)) {
  console.log(`✓ inline math: ${samples.length} samples`);
}
for (const name of ["structured", "hard", "declaration", "exam"]) {
  const data = readFileSync(join(dir, `${name}.pdf`));
  const { doc, pdf } = await extractDocument(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  const js = view(doc);
  const py = view(JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")));
  py.forEach((pyPage, i) => {
    const a = JSON.stringify(pyPage), b = JSON.stringify(js[i]);
    if (a !== b) {
      failures++;
      console.error(`✗ ${name} p${i + 1}\n  python: ${a}\n  js:     ${b}`);
    } else console.log(`✓ ${name} p${i + 1}: ${pyPage.length} blocks`);
  });
  const jsFid = JSON.stringify(verdict(assess(doc, await referenceItems(pdf, doc.pages.map((p) => p.number)), captionText)));
  const pyFid = JSON.stringify(verdict(JSON.parse(readFileSync(join(dir, `${name}.fidelity.json`), "utf8"))));
  if (jsFid !== pyFid) {
    failures++;
    console.error(`✗ ${name} fidelity
  python: ${pyFid}
  js:     ${jsFid}`);
  } else console.log(`✓ ${name} fidelity: ${JSON.parse(jsFid).status}`);
  // The layout editor reads a region again the way the extraction read it: every block's own
  // region, read as its own type, gives back the block's content.
  let reread = 0;
  for (const page of doc.pages) {
    const glyphs = await pageGlyphs(pdf, page.number);
    for (const b of page.blocks) {
      if (!b.bbox || b.type === "figure") continue;
      const r = readRegion(glyphs, b.bbox, b.type);
      const [got, want] = b.type === "table" ? [r.rows, b.rows] : b.type === "formula" ? [r.latex, b.latex] : [r.text, b.text];
      if (JSON.stringify(got) === JSON.stringify(want)) { reread++; continue; }
      failures++;
      console.error(`✗ ${name} ${b.id} read again as ${b.type}\n  extracted: ${JSON.stringify(want)}\n  re-read:   ${JSON.stringify(got)}`);
    }
  }
  console.log(`✓ ${name} regions read again: ${reread} blocks`);
  const pyDoc = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
  const md = same(`${name} markdown, math as LaTeX`, readFileSync(join(dir, `${name}.latex.md`), "utf8"), toMarkdown(pyDoc, { images: "none", math: "latex" }));
  const txt = same(`${name} text, math as LaTeX`, readFileSync(join(dir, `${name}.latex.txt`), "utf8"), toText(pyDoc, { math: "latex" }));
  if (md && txt) console.log(`✓ ${name} markdown and text with LaTeX math`);
  if (name === "structured") {
    // Take a paragraph out: the report must say so, and say where on the page it was.
    const first = doc.pages[0];
    const cut = { ...doc, pages: [{ ...first, blocks: first.blocks.filter((b) => b.type !== "paragraph") }, ...doc.pages.slice(1)] };
    const lost = assess(cut, await referenceItems(pdf, doc.pages.map((p) => p.number)), captionText);
    const where = lost.pages.get(1).missing.length;
    if (lost.issues[0]?.code !== "text_loss" || !where || lost.pages.get(2).missing.length) {
      failures++;
      console.error(`✗ ${name} text loss not located: ${JSON.stringify(lost.issues)} (${where} spans)`);
    } else console.log(`✓ ${name} text loss located: ${where} spans on p1`);
  }
}
process.exit(failures ? 1 : 0);
