// Local deterministic embedding: hashed bag-of-words + bigrams, 256 dims, L2-normalised.
// Same function for chunks and queries, so cosine similarity is meaningful without any API.
import { tokenize } from "./text";

export const EMBED_DIMS = 256;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function add(vec: Float64Array, feature: string, weight: number) {
  const h = fnv1a(feature);
  const sign = (h >>> 16) & 1 ? 1 : -1;
  vec[h % EMBED_DIMS] += sign * weight;
}

export function embed(text: string): number[] {
  const toks = tokenize(text);
  const vec = new Float64Array(EMBED_DIMS);
  if (toks.length === 0) return Array.from(vec);
  const tf = new Map<string, number>();
  for (const t of toks) tf.set("u:" + t, (tf.get("u:" + t) ?? 0) + 1);
  for (let i = 0; i + 1 < toks.length; i++) {
    const k = "b:" + toks[i] + " " + toks[i + 1];
    tf.set(k, (tf.get(k) ?? 0) + 1);
  }
  for (const [k, n] of tf) add(vec, k, (k.startsWith("b:") ? 0.6 : 1) * (1 + Math.log(n)));
  let norm = 0;
  for (let i = 0; i < EMBED_DIMS; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec, (v) => Math.round((v / norm) * 1e5) / 1e5);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function parseEmbedding(json: string | null | undefined): number[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) && v.length === EMBED_DIMS ? (v as number[]) : null;
  } catch {
    return null;
  }
}
