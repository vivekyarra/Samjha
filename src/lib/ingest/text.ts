// Pure text helpers for ingestion (no server-only imports so they can be unit-tested and used client-side).

export interface PageText {
  page: number;
  /** Clean text shown in the citation viewer and used for chunks. */
  text: string;
  /** Optional annotated text for the extractor (e.g. "## " prefixes on large-font PDF lines). */
  marked?: string;
}

export const STOPWORDS = new Set(
  (
    "a an the and or but if then else of to in on at by for with from into onto over under about as is are was were be been being " +
    "this that these those it its it's they them their there here we our us you your i me my he she his her him which who whom whose " +
    "what when where why how all any each every some such no not nor only own same so than too very can could should would may might " +
    "will shall must do does did doing done have has had having just also both either neither via per vs etc e.g i.e eg ie"
  ).split(/\s+/),
);

/** Normalise whitespace while keeping line structure; join hyphenated line breaks. */
export function cleanPageText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/­/g, "")
    .replace(/[‐‑]/g, "-")
    .replace(/[^\S\n]+/g, " ")
    .replace(/([a-z])-\n([a-z])/g, "$1$2")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Split long text into pages: form-feeds first, else ~maxChars on paragraph/heading boundaries. */
export function splitTextIntoPages(text: string, maxChars = 3000): PageText[] {
  const cleaned = text.replace(/\r\n?/g, "\n");
  const raw = cleaned.includes("\f") ? cleaned.split("\f") : [cleaned];
  const pages: string[] = [];
  for (const block of raw) {
    if (block.length <= maxChars) {
      pages.push(block);
      continue;
    }
    const paras = block.split(/\n(?=\s*\n)|\n(?=#{1,6}\s)/);
    let cur = "";
    for (const p of paras) {
      if (cur && cur.length + p.length > maxChars) {
        pages.push(cur);
        cur = "";
      }
      if (p.length > maxChars) {
        // a single giant paragraph: cut on sentence boundaries
        for (const s of splitSentences(p)) {
          if (cur && cur.length + s.length + 1 > maxChars) {
            pages.push(cur);
            cur = "";
          }
          cur += (cur ? " " : "") + s;
        }
      } else cur += (cur ? "\n" : "") + p;
    }
    if (cur.trim()) pages.push(cur);
  }
  return pages
    .map((t) => cleanPageText(t))
    .filter((t) => t.length > 0)
    .map((t, i) => ({ page: i + 1, text: t }));
}

const ABBREV = /\b(e\.g|i\.e|etc|vs|fig|eq|approx|resp|cf|al|dr|mr|mrs|ms|prof|no|vol|sec|ch)\.$/i;

/** Sentence splitter that respects common abbreviations, decimals and initials. */
export function splitSentences(text: string): string[] {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return [];
  const out: string[] = [];
  let start = 0;
  const re = /[.!?]+["')\]]*\s+(?=[A-Z0-9"'(\[])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const end = m.index + m[0].trimEnd().length;
    const piece = t.slice(start, end);
    if (ABBREV.test(piece) || /\b[A-Z]\.$/.test(piece) || /\d\.$/.test(piece) && /^\d/.test(t.slice(re.lastIndex))) continue;
    if (piece.trim()) out.push(piece.trim());
    start = re.lastIndex;
  }
  const rest = t.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

/** Very light stemmer: enough to match plural/verb forms for hashing + fuzzy names. */
export function stem(word: string): string {
  if (word.length <= 3 || /\d/.test(word)) return word;
  // British → American spelling so "regularisation" and "regularization" match
  const w = word.replace(/isation$/, "ization").replace(/is(e|ed|es|ing)$/, "iz$1").replace(/yse$/, "yze").replace(/our$/, "or");
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 4 && !w.endsWith("eed")) return w.slice(0, -2);
  if (w.endsWith("es") && /(ch|sh|x|z|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) return w.slice(0, -1);
  return w;
}

/** Raw lowercase word tokens (keeps stopwords). */
export function words(text: string): string[] {
  return (text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? []).map((w) =>
    w.replace(/'s$/, ""),
  );
}

/** Content tokens: lowercase, stemmed, stopwords removed. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const w of words(text)) {
    if (STOPWORDS.has(w)) continue;
    if (w.length < 2 && !/\d/.test(w)) continue;
    out.push(stem(w));
  }
  return out;
}

const NAME_NOISE = [
  /^\s*#+\s*/,
  /^\s*(chapter|lecture|unit|module|week|part|section|topic|lesson|session|class)\s*[\divxlc]*\s*[.:\-–—)]*\s*/i,
  /^\s*[\divx]+(\.\d+)*[.)]?\s+/i,
  /\s*\((cont(inued|'d|d)?\.?|part\s*\d+)\)\s*$/i,
  /\s*[-–—:]\s*(cont(inued|'d|d)?\.?|part\s*(\d+|[ivx]+))\s*$/i,
  /\s+cont(inued|'d|d)?\.?\s*$/i,
  /[:.\s]+$/,
];

/** Clean a heading into a display topic name. */
export function cleanTopicName(name: string): string {
  let n = name.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 2; i++) for (const re of NAME_NOISE) n = n.replace(re, "");
  n = n.replace(/^[*_`"'\s]+|[*_`"'\s]+$/g, "").trim();
  if (!n) return name.trim().slice(0, 80);
  const letters = n.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 4 && letters === letters.toUpperCase()) n = titleCase(n.toLowerCase(), true);
  else n = n[0].toUpperCase() + n.slice(1);
  return n.length > 80 ? n.slice(0, 80).replace(/\s+\S*$/, "") : n;
}

const SMALL = new Set(["a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "vs", "via", "by", "at"]);
const KNOWN_ACRONYMS = new Set(["ml", "ai", "sgd", "svm", "cnn", "rnn", "lstm", "gpu", "cpu", "dna", "rna", "atp", "pca", "knn", "mle", "map", "api", "sql", "os", "tcp", "ip", "http", "gdp", "relu", "mse", "nlp", "llm", "rl", "dp", "bfs", "dfs"]);

export function titleCase(s: string, fromCaps = false): string {
  return s
    .split(/(\s+)/)
    .map((w, i) => {
      if (/^\s+$/.test(w)) return w;
      const lw = w.toLowerCase();
      if (fromCaps && KNOWN_ACRONYMS.has(lw.replace(/[^a-z]/g, ""))) return w.toUpperCase();
      if (i > 0 && SMALL.has(lw)) return lw;
      return w[0].toUpperCase() + w.slice(1);
    })
    .join("");
}

/** Normalised topic-name key for exact-ish matching. */
export function normName(name: string): string {
  return tokenize(cleanTopicName(name)).join(" ");
}

/** Normalised claim key for exact duplicate detection. */
export function normClaim(text: string): string {
  return tokenize(text).join(" ");
}

export function wordCount(s: string): number {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}
