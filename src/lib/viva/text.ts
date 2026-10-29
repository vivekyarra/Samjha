// Small local text helpers for the no-AI examiner (keyword overlap grading, keyword picking).

const STOP = new Set(
  "a an the and or but if then else of to in on at by for with from into onto as is are was were be been being it its this that these those there here which who whom whose what when where why how than so such can could should would may might must will shall do does did done have has had having not no nor very also just only more most less least many much some any each every all both either neither own same other another i you he she we they me him her us them my your our their mine yours one two using use used via within without about over under between through during before after above below up down out off again further once because while until per e g ie etc".split(" "),
);

export function stem(w: string): string {
  let s = w.toLowerCase();
  if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("ies")) s = s.slice(0, -3) + "y";
  else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("es") && !s.endsWith("ses")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  return s;
}

export function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9+#._-]*/g) ?? []).map((w) => w.replace(/[._-]+$/, ""));
}

export function contentWords(text: string): string[] {
  return words(text).filter((w) => w.length > 2 && !STOP.has(w));
}

export function stemSet(text: string): Set<string> {
  return new Set(contentWords(text).map(stem));
}

/** Fraction of the claim's content words present in the answer (stemmed, with prefix tolerance). */
export function coverage(claim: string, answer: string): number {
  const c = [...stemSet(claim)];
  if (!c.length) return 0;
  const a = [...stemSet(answer)];
  const aSet = new Set(a);
  let hit = 0;
  for (const w of c) {
    if (aSet.has(w) || (w.length >= 5 && a.some((x) => x.length >= 5 && (x.startsWith(w.slice(0, 5)) || w.startsWith(x.slice(0, 5)))))) hit++;
  }
  return hit / c.length;
}

const NEG = /\b(not|never|no|doesn'?t|don'?t|isn'?t|aren'?t|won'?t|cannot|can'?t|without)\b/i;

/** Detects an answer sentence that matches the claim but flips its negation. */
export function contradicts(claim: string, answer: string): string | null {
  const claimNeg = NEG.test(claim);
  for (const s of answer.split(/(?<=[.!?])\s+|\n+/)) {
    if (coverage(claim, s) >= 0.45 && NEG.test(s) !== claimNeg) return s.trim();
  }
  return null;
}

/** Best verbatim snippet of the answer supporting a claim (for scorecard "strong"). */
export function bestSnippet(claim: string, answer: string): string {
  let best = "";
  let score = 0;
  for (const s of answer.split(/(?<=[.!?,;])\s+|\n+/)) {
    const c = coverage(claim, s);
    if (c > score) { score = c; best = s.trim(); }
  }
  return best.length > 140 ? best.slice(0, 137) + "…" : best;
}

/** Salient keywords of a text not present in `exclude` (longest first). */
export function keywords(text: string, exclude = "", n = 2): string[] {
  const ex = stemSet(exclude);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of contentWords(text).sort((x, y) => y.length - x.length)) {
    const s = stem(w);
    if (ex.has(s) || seen.has(s) || w.length < 4 || /^\d+$/.test(w)) continue;
    seen.add(s);
    out.push(w);
    if (out.length >= n) break;
  }
  return out;
}

export function wordCount(text: string): number {
  return (text.trim().match(/\S+/g) ?? []).length;
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function shorten(text: string, max = 90): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
