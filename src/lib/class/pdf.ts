// One-page professor report (pdf-lib). Contains only the anonymous aggregates from classView.
import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { ClassHeatmap } from "./aggregate";
import type { MisunderstoodClaim } from "./index";

const A4: [number, number] = [595.28, 841.89];
const M = 40;
const INK = rgb(0.11, 0.11, 0.1);
const MUTED = rgb(0.42, 0.41, 0.38);
const LINE = rgb(0.85, 0.84, 0.8);
const FILL = { red: rgb(0.98, 0.9, 0.89), amber: rgb(0.98, 0.94, 0.84), green: rgb(0.86, 0.95, 0.89) };

/** Standard fonts are WinAnsi only: normalise quotes/dashes and drop anything else. */
function safe(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/≥/g, ">=")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = safe(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width) cur = next;
    else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

function fit(text: string, font: PDFFont, size: number, width: number): string {
  let t = safe(text);
  if (font.widthOfTextAtSize(t, size) <= width) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > width) t = t.slice(0, -1);
  return `${t.trimEnd()}...`;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const label = { red: "Weak", amber: "Shaky", green: "Strong" } as const;

export async function buildReportPdf(opts: { heatmap: ClassHeatmap; misunderstood: MisunderstoodClaim[]; link?: string; date?: Date }): Promise<Uint8Array> {
  const { heatmap, misunderstood } = opts;
  const doc = await PDFDocument.create();
  doc.setTitle(safe(`Samjha class report - ${heatmap.subjectName}`));
  doc.setProducer("Samjha");
  const page: PDFPage = doc.addPage(A4);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = A4[0] - M * 2;
  let y = A4[1] - M;

  const text = (s: string, x: number, size: number, f = font, color = INK) => page.drawText(safe(s), { x, y, size, font: f, color });

  text("Samjha class report", M, 10, bold, MUTED);
  y -= 22;
  for (const l of wrap(heatmap.subjectName, bold, 18, W).slice(0, 2)) {
    text(l, M, 18, bold);
    y -= 22;
  }
  const date = (opts.date ?? new Date()).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const shown = heatmap.topics.filter((t) => !t.suppressed);
  text(`${date}  |  ${heatmap.students} student${heatmap.students === 1 ? "" : "s"} in class  |  ${shown.length} of ${heatmap.topics.length} topics with enough data`, M, 10, font, MUTED);
  y -= 14;
  text(`Anonymous: counts only. A topic appears once at least ${heatmap.minStudents} students have attempted it.`, M, 8.5, font, MUTED);
  y -= 22;

  // --- Heatmap table ---
  text("Class heatmap: share of students who have each topic solid", M, 12, bold);
  y -= 8;
  const cols = { topic: M + 6, students: M + W - 200, green: M + W - 120 };
  const rowH = 16;
  const reserve = 60 + Math.max(1, misunderstood.length) * 46;
  const maxRows = Math.max(3, Math.floor((y - M - reserve) / rowH) - 1);
  const sorted = [...shown.sort((a, b) => (a.greenShare ?? 0) - (b.greenShare ?? 0)), ...heatmap.topics.filter((t) => t.suppressed)];
  const rows = sorted.slice(0, maxRows);

  y -= rowH;
  page.drawRectangle({ x: M, y: y - 4, width: W, height: rowH, color: rgb(0.94, 0.93, 0.91) });
  text("Topic", cols.topic, 9, bold, MUTED);
  text("Students", cols.students, 9, bold, MUTED);
  text("% green", cols.green, 9, bold, MUTED);
  for (const t of rows) {
    y -= rowH;
    if (!t.suppressed && t.colour) page.drawRectangle({ x: M, y: y - 4, width: W, height: rowH, color: FILL[t.colour] });
    page.drawLine({ start: { x: M, y: y - 4 }, end: { x: M + W, y: y - 4 }, thickness: 0.5, color: LINE });
    text(fit(t.name, font, 9.5, cols.students - cols.topic - 10), cols.topic, 9.5, font, t.suppressed ? MUTED : INK);
    text(String(t.attempted), cols.students, 9.5, font, t.suppressed ? MUTED : INK);
    if (t.suppressed) text(`Collecting responses (${t.attempted}/${heatmap.minStudents})`, cols.green, 8.5, font, MUTED);
    else text(`${pct(t.greenShare ?? 0)}  ${t.colour ? label[t.colour] : ""}`, cols.green, 9.5, bold);
  }
  if (sorted.length > rows.length) {
    y -= 14;
    text(`+ ${sorted.length - rows.length} more topics (see online report)`, cols.topic, 8.5, font, MUTED);
  }
  y -= 28;

  // --- Most misunderstood ---
  text("Top misunderstood claims", M, 12, bold);
  y -= 16;
  if (!misunderstood.length) {
    text("Collecting responses: claims appear here once several students in a topic with 5+ students have them marked wrong.", M, 9.5, font, MUTED);
    y -= 14;
  }
  misunderstood.forEach((m, i) => {
    if (y < M + 30) return;
    const head = wrap(`${i + 1}. ${m.text}`, bold, 10, W).slice(0, 2);
    for (const l of head) {
      text(l, M, 10, bold);
      y -= 13;
    }
    text(fit(`${m.topicName}  |  marked wrong for ${m.wrong} of ${m.attempted} students${m.page ? `  |  notes p.${m.page}` : ""}`, font, 8.5, W), M + 12, 8.5, font, MUTED);
    y -= 12;
    for (const l of wrap(m.misconception, font, 9.5, W - 12).slice(0, 2)) {
      text(l, M + 12, 9.5);
      y -= 12;
    }
    y -= 8;
  });

  y = M - 12;
  if (opts.link) text(fit(`Live report: ${opts.link}`, font, 8, W), M, 8, font, MUTED);
  return doc.save();
}
