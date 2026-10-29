// File → page texts. PDF via unpdf (per page, large-font lines marked as headings for the extractor).
import "server-only";
import { cleanPageText, splitTextIntoPages, type PageText } from "./text";

interface PdfItem { str: string; fontSize: number; hasEOL: boolean }

/** Rebuild lines from positioned items and mark lines noticeably larger than body text as headings. */
function pagesFromItems(items: PdfItem[][]): PageText[] {
  const pageLines = items.map((page) => {
    const lines: { text: string; size: number }[] = [];
    let text = "", size = 0, weight = 0;
    const flush = () => {
      const t = text.replace(/\s+/g, " ").trim();
      if (t) lines.push({ text: t, size: weight ? size / weight : 0 });
      text = "";
      size = 0;
      weight = 0;
    };
    for (const it of page) {
      text += it.str;
      const w = it.str.trim().length;
      if (w) {
        size += (it.fontSize || 0) * w;
        weight += w;
      }
      if (it.hasEOL) flush();
    }
    flush();
    return lines;
  });
  // body size = character-weighted median
  const sizes: { s: number; w: number }[] = [];
  for (const ls of pageLines) for (const l of ls) if (l.size > 0) sizes.push({ s: Math.round(l.size * 2) / 2, w: l.text.length });
  sizes.sort((a, b) => a.s - b.s);
  const total = sizes.reduce((a, b) => a + b.w, 0);
  let acc = 0, body = 0;
  for (const x of sizes) {
    acc += x.w;
    if (acc >= total / 2) {
      body = x.s;
      break;
    }
  }
  const headingSizes = [...new Set(sizes.filter((x) => body && x.s >= body * 1.2).map((x) => x.s))].sort((a, b) => b - a);
  // sizes within ~13% of each other are the same heading level (slide titles vary slightly)
  const clusterOf = new Map<number, number>();
  let cluster = 0, clusterTop = 0;
  for (const s of headingSizes) {
    if (!clusterTop || s < clusterTop * 0.87) {
      cluster++;
      clusterTop = s;
    }
    clusterOf.set(s, cluster);
  }
  const level = (s: number) => Math.min(3, clusterOf.get(Math.round(s * 2) / 2) ?? 3);
  const useMarks = cluster > 0 && cluster <= 4;
  return pageLines.map((ls, i) => {
    const text = cleanPageText(ls.map((l) => l.text).join("\n"));
    const marked = useMarks
      ? cleanPageText(
          ls
            .map((l) => {
              const isHead = l.size >= body * 1.2 && l.text.split(/\s+/).length <= 12 && !/[.;,]$/.test(l.text) && /[A-Za-z]{2}/.test(l.text);
              return isHead ? `${"#".repeat(level(l.size))} ${l.text}` : l.text;
            })
            .join("\n"),
        )
      : undefined;
    return { page: i + 1, text, marked };
  });
}

export async function parsePdf(data: Buffer): Promise<PageText[]> {
  const { getDocumentProxy, extractTextItems, extractText } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(data));
  try {
    const { items } = await extractTextItems(pdf);
    return pagesFromItems(items as PdfItem[][]);
  } catch {
    const { text } = await extractText(pdf, { mergePages: false });
    return text.map((t, i) => ({ page: i + 1, text: cleanPageText(t) }));
  }
}

export function parsePlainText(text: string): PageText[] {
  return splitTextIntoPages(text, 3000);
}

export type FileKind = "pdf" | "text" | "image" | "unsupported";

export function fileKind(fileName: string, mime: string): FileKind {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif", "heic"].includes(ext)) return "image";
  if (mime.startsWith("text/") || ["txt", "md", "markdown", "text", "rst", "org", "csv", "tex"].includes(ext) || mime === "application/json" || !mime) return "text";
  return "unsupported";
}

export function imageMediaType(fileName: string, mime: string): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null {
  const m = mime.toLowerCase();
  if (m === "image/png" || m === "image/jpeg" || m === "image/webp" || m === "image/gif") return m;
  const ext = fileName.toLowerCase().split(".").pop();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return null;
}
