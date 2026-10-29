// Gaps-only revision sheet renderer (pure: no DB) so it can be tested with tsx.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { citation } from "./questions";

export const GAPS_TITLE = "Samjha — Gaps-only revision sheet";

export interface GapClaim { id: string; text: string; page: number | null; file_name: string | null; mastery: "red" | "amber"; correction: string | null }
export interface GapTopic { id: string; name: string; explanation: string | null; claims: GapClaim[] }
export interface GapSubject { id: string; name: string; examDate: string | null; topics: GapTopic[]; notStarted?: string[] }

const GREEK: Record<string, string> = {
  α: "alpha", β: "beta", γ: "gamma", δ: "delta", ε: "epsilon", η: "eta", θ: "theta", λ: "lambda", μ: "mu", π: "pi",
  σ: "sigma", τ: "tau", φ: "phi", ω: "omega", Δ: "Delta", Σ: "Sum", "∑": "sum", "∇": "grad", "∂": "d", "→": "->", "←": "<-",
  "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~", "−": "-", "×": "x", "√": "sqrt", "∞": "inf", "…": "...",
};

function sanitizer(font: PDFFont) {
  const cache = new Map<string, string>();
  return (s: string) =>
    Array.from(s.replace(/[\r\t]/g, " "))
      .map((ch) => {
        if (ch === "\n") return ch;
        const hit = cache.get(ch);
        if (hit !== undefined) return hit;
        let out = GREEK[ch] ?? ch;
        if (out === ch) {
          try {
            font.encodeText(ch);
          } catch {
            out = "?";
          }
        }
        cache.set(ch, out);
        return out;
      })
      .join("");
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const tryLine = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(tryLine, size) <= width) {
        line = tryLine;
        continue;
      }
      if (line) lines.push(line);
      // Hard-break words wider than the line.
      let w = word;
      while (font.widthOfTextAtSize(w, size) > width && w.length > 1) {
        let cut = w.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--;
        lines.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      line = w;
    }
    lines.push(line);
  }
  return lines;
}

interface Block { text: string; font: "regular" | "bold" | "italic"; scale: number; indent: number; color: RGB; gap: number; badge?: "red" | "amber" }

const C = { fg: rgb(0.11, 0.106, 0.098), muted: rgb(0.42, 0.408, 0.376), red: rgb(0.863, 0.29, 0.239), amber: rgb(0.851, 0.576, 0.051) };
const LABEL = { red: "NEEDS WORK", amber: "SHAKY" } as const;

function blocksFor(s: GapSubject): Block[] {
  const b: Block[] = [];
  const add = (text: string, o: Partial<Block> = {}) => b.push({ text, font: "regular", scale: 1, indent: 0, color: C.fg, gap: 0, ...o });
  const notStarted = s.notStarted?.length ? `Not explained yet: ${s.notStarted.join(", ")}.` : "";
  if (!s.topics.length) {
    add("No red or amber claims in the topics you've explained so far. Nothing to patch.", { color: C.muted, gap: 6 });
    if (notStarted) add(notStarted, { color: C.muted, gap: 6 });
    return b;
  }
  for (const t of s.topics) {
    add(t.name, { font: "bold", scale: 1.2, gap: 10 });
    if (t.explanation) add(`Buddy: ${t.explanation}`, { font: "italic", color: C.muted, gap: 2 });
    for (const c of t.claims) {
      const cite = citation(c.file_name, c.page);
      add(`${c.text}${cite ? `  ${cite}` : ""}`, { indent: 62, gap: 5, badge: c.mastery });
      if (c.correction && c.correction.trim() && c.correction.trim() !== c.text.trim()) {
        add(`Fix: ${c.correction}`, { indent: 62, color: C.muted, gap: 1 });
      }
    }
  }
  if (notStarted) add(notStarted, { color: C.muted, gap: 12 });
  return b;
}

const PAGE = { w: 595.28, h: 841.89, margin: 42 };

export async function buildGapsPdf(subjects: GapSubject[], studentName: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(GAPS_TITLE);
  pdf.setAuthor("Samjha");
  pdf.setCreator("Samjha");
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
  };
  const clean = sanitizer(fonts.bold);
  const contentW = PAGE.w - PAGE.margin * 2;
  const today = new Date().toISOString().slice(0, 10);

  if (!subjects.length) subjects = [{ id: "", name: "No subjects yet", examDate: null, topics: [] }];

  for (const s of subjects) {
    const blocks = blocksFor(s).map((bl) => ({ ...bl, text: clean(bl.text) }));
    const headerH = 64;
    const measure = (size: number) =>
      blocks.reduce((h, bl) => {
        const sz = size * bl.scale;
        return h + bl.gap + wrap(bl.text, fonts[bl.font], sz, contentW - bl.indent).length * sz * 1.3;
      }, 0);
    // Shrink font so the subject fits on one page; below 7pt, paginate instead.
    let size = 11;
    while (size > 7 && measure(size) > PAGE.h - PAGE.margin * 2 - headerH - 20) size -= 0.5;

    let page: PDFPage = pdf.addPage([PAGE.w, PAGE.h]);
    let y = PAGE.h - PAGE.margin;
    const header = (cont: boolean) => {
      page.drawText(clean(GAPS_TITLE), { x: PAGE.margin, y: y - 14, size: 14, font: fonts.bold, color: C.fg });
      y -= 34;
      const meta = [s.name + (cont ? " (continued)" : ""), s.examDate ? `exam ${s.examDate.slice(0, 10)}` : null, studentName, today].filter(Boolean).join("  ·  ");
      page.drawText(clean(meta), { x: PAGE.margin, y, size: 10, font: fonts.regular, color: C.muted });
      y -= 12;
      page.drawLine({ start: { x: PAGE.margin, y }, end: { x: PAGE.w - PAGE.margin, y }, thickness: 0.6, color: C.muted });
      y -= 18;
    };
    header(false);

    for (const bl of blocks) {
      const sz = size * bl.scale;
      const lh = sz * 1.3;
      const font = fonts[bl.font];
      const lines = wrap(bl.text, font, sz, contentW - bl.indent);
      y -= bl.gap;
      if (y - lh < PAGE.margin) {
        page = pdf.addPage([PAGE.w, PAGE.h]);
        y = PAGE.h - PAGE.margin;
        header(true);
      }
      if (bl.badge) {
        const col = C[bl.badge];
        const bs = size * 0.75;
        page.drawRectangle({ x: PAGE.margin, y: y - sz + 1, width: bs, height: bs, color: col });
        page.drawText(LABEL[bl.badge], { x: PAGE.margin + bs + 3, y: y - sz + 1.5, size: size * 0.7, font: fonts.bold, color: col });
      }
      for (const line of lines) {
        if (y - lh < PAGE.margin) {
          page = pdf.addPage([PAGE.w, PAGE.h]);
          y = PAGE.h - PAGE.margin;
          header(true);
        }
        page.drawText(line, { x: PAGE.margin + bl.indent, y: y - sz, size: sz, font, color: bl.color });
        y -= lh;
      }
    }
    const legend = "NEEDS WORK = red (wrong or missing)   SHAKY = amber (got it with help, or due again)";
    page.drawText(legend, { x: PAGE.margin, y: PAGE.margin - 22, size: 7, font: fonts.regular, color: C.muted });
  }
  return pdf.save();
}

