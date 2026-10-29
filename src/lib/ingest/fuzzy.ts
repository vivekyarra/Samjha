// Fuzzy name matching + duplicate detection (pure; used server-side for merging and client-side for voice commands).
import { cosine, embed } from "./embed";
import { normClaim, normName, tokenize, words, STOPWORDS } from "./text";

function trigrams(s: string): Set<string> {
  const p = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
  return out;
}

/** Dice coefficient over character trigrams (0..1). */
export function trigramSim(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = trigrams(a), B = trigrams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

function tokenSim(a: string, b: string): number {
  if (a === b) return 1;
  const short = a.length <= b.length ? a : b, long = a.length <= b.length ? b : a;
  if (short.length >= 4 && long.startsWith(short)) return 0.85;
  const t = trigramSim(a, b);
  return t >= 0.55 ? t : 0;
}

function initials(name: string): string {
  return words(name).filter((w) => !STOPWORDS.has(w)).map((w) => w[0]).join("");
}

/**
 * How well `query` refers to `name` (0..1). Handles prefixes ("backprop" → "Backpropagation"),
 * acronyms ("SGD" → "Stochastic Gradient Descent"), typos, and partial names.
 */
export function nameSimilarity(query: string, name: string): number {
  const qa = normName(query), na = normName(name);
  if (!qa || !na) return 0;
  if (qa === na) return 1;
  const qt = qa.split(" "), nt = na.split(" ");
  const ini = initials(name);
  if (qt.length === 1 && ini.length >= 2 && qt[0] === ini) return 0.9;
  // a name with an explicit acronym, e.g. "Support Vector Machines (SVM)"
  if (qt.length === 1 && nt.includes(qt[0]) && qt[0].length <= 5 && nt.length > 1 && /\(/.test(name)) return 0.9;
  const best = (xs: string[], ys: string[]) => xs.reduce((s, x) => s + Math.max(0, ...ys.map((y) => tokenSim(x, y))), 0) / xs.length;
  const qCover = best(qt, nt), nCover = best(nt, qt);
  const tok = 0.6 * qCover + 0.4 * nCover;
  const chars = trigramSim(qa.replace(/ /g, ""), na.replace(/ /g, ""));
  return Math.max(tok, chars * 0.9);
}

/** Symmetric similarity used to decide whether two topic names are the same topic. */
export function sameNameScore(a: string, b: string): number {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const A = new Set(na.split(" ")), B = new Set(nb.split(" "));
  let inter = 0;
  for (const t of A) if (B.has(t) || [...B].some((u) => tokenSim(t, u) >= 0.85)) inter++;
  const jacc = inter / (A.size + B.size - inter);
  return Math.max(jacc, trigramSim(na, nb) * 0.95);
}

export function bestMatch<T>(query: string, items: T[], getName: (t: T) => string, threshold = 0.5): { item: T; score: number } | null {
  let best: { item: T; score: number } | null = null;
  for (const item of items) {
    const score = nameSimilarity(query, getName(item));
    if (score >= threshold && (!best || score > best.score)) best = { item, score };
  }
  return best;
}

export interface TopicLike {
  name: string;
  /** Embedding of name + claims (centroid); computed lazily if absent. */
  vec?: number[];
  claimTexts: string[];
}

export function topicVector(name: string, claimTexts: string[]): number[] {
  return embed(`${name} ${name} ${claimTexts.join(" ")}`);
}

/**
 * Index of the existing topic that `incoming` should merge into, or -1.
 * Strong name match wins; otherwise a moderate name match backed by content similarity.
 */
export function matchTopic(incoming: TopicLike, existing: TopicLike[]): number {
  let bestIdx = -1, bestScore = 0;
  const inVec = incoming.vec ?? topicVector(incoming.name, incoming.claimTexts);
  existing.forEach((t, i) => {
    const ns = sameNameScore(incoming.name, t.name);
    let score = 0;
    if (ns >= 0.8) score = 1 + ns;
    else if (ns >= 0.34 && incoming.claimTexts.length && t.claimTexts.length) {
      const cs = cosine(inVec, t.vec ?? topicVector(t.name, t.claimTexts));
      if (cs >= 0.55) score = ns + cs;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  });
  return bestIdx;
}

export interface ClaimLike { text: string; vec?: number[]; key?: string }

/** Is `text` a duplicate of any claim in `pool`? (exact normalised match or high embedding similarity). */
export function isDuplicateClaim(text: string, pool: ClaimLike[], threshold = 0.82): boolean {
  const key = normClaim(text);
  if (!key) return true;
  const v = embed(text);
  const kt = new Set(key.split(" "));
  for (const c of pool) {
    const ck = c.key ?? normClaim(c.text);
    if (ck === key) return true;
    if (cosine(v, c.vec ?? embed(c.text)) >= threshold) return true;
    // near-identical token sets (re-ordered wording)
    const ct = ck.split(" ");
    const inter = ct.filter((t) => kt.has(t)).length;
    if (ct.length >= 4 && inter / Math.max(ct.length, kt.size) >= 0.85) return true;
  }
  return false;
}

/** Tokens that make a name too generic to use for prerequisite detection. */
export function isGenericName(name: string): boolean {
  const t = tokenize(name);
  return t.length === 0 || t.every((x) => GENERIC.has(x));
}
const GENERIC = new Set(
  "introduction intro overview summary conclusion recap review basic basics background motivation outline agenda contents example exercise problem question note notes definition key point idea concept application miscellaneous misc general part chapter lecture unit appendix reference".split(" "),
);
