// Pure class-heatmap aggregation (no DB, no server-only) so it can be unit-tested with tsx.
// Inputs are counts produced by aggregate SQL; outputs never contain user ids or names.
import type { Mastery } from "../types";

export const MIN_STUDENTS = 5;
/** A claim needs this many distinct students marked wrong before it can appear in "most misunderstood". */
export const MIN_WRONG_STUDENTS = 2;
/** A student phrase is only quoted (in the offline fallback) if this many distinct students wrote it. */
export const MIN_SHARED_PHRASE = 3;

export interface TopicInput { id: string; name: string; position: number }
export interface ClaimInput { id: string; topic_id: string; text: string; source_id: string | null; page: number | null; position: number }
export interface TopicCount { topic_id: string; attempted: number }
export interface ClaimCount { claim_id: string; green?: number; wrong?: number; wrong_marks?: number }

export interface ClassClaimCell {
  claimId: string;
  text: string;
  sourceId: string | null;
  page: number | null;
  /** null while the topic is suppressed. */
  green: number | null;
  greenShare: number | null;
  wrong: number | null;
}
export interface ClassTopicCell {
  topicId: string;
  name: string;
  attempted: number;
  suppressed: boolean;
  greenShare: number | null;
  colour: Mastery | null;
  claims: ClassClaimCell[];
}
export interface ClassHeatmap {
  subjectId: string;
  subjectName: string;
  students: number;
  minStudents: number;
  topics: ClassTopicCell[];
}

export function defaultColour(share: number): Mastery {
  return share >= 0.7 ? "green" : share >= 0.4 ? "amber" : "red";
}

const clampCount = (n: number | undefined, max: number) => Math.max(0, Math.min(Number(n ?? 0), max));

export function buildClassHeatmap(input: {
  subjectId: string;
  subjectName: string;
  students: number;
  topics: TopicInput[];
  claims: ClaimInput[];
  topicCounts: TopicCount[];
  claimCounts: ClaimCount[];
  colour?: (share: number) => Mastery;
  minStudents?: number;
}): ClassHeatmap {
  const min = input.minStudents ?? MIN_STUDENTS;
  const colour = input.colour ?? defaultColour;
  const attemptedBy = new Map(input.topicCounts.map((t) => [t.topic_id, Number(t.attempted) || 0]));
  const countBy = new Map(input.claimCounts.map((c) => [c.claim_id, c]));

  const topics = [...input.topics]
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
    .map<ClassTopicCell>((t) => {
      const attempted = attemptedBy.get(t.id) ?? 0;
      const suppressed = attempted < min;
      const claims = input.claims
        .filter((c) => c.topic_id === t.id)
        .sort((a, b) => a.position - b.position)
        .map<ClassClaimCell>((c) => {
          const base = { claimId: c.id, text: c.text, sourceId: c.source_id, page: c.page };
          if (suppressed) return { ...base, green: null, greenShare: null, wrong: null };
          const cnt = countBy.get(c.id);
          const green = clampCount(cnt?.green, attempted);
          return { ...base, green, greenShare: green / attempted, wrong: clampCount(cnt?.wrong, attempted) };
        });
      let greenShare: number | null = null;
      if (!suppressed) {
        greenShare = claims.length ? claims.reduce((s, c) => s + (c.greenShare ?? 0), 0) / claims.length : 0;
      }
      return {
        topicId: t.id,
        name: t.name,
        attempted,
        suppressed,
        greenShare,
        colour: greenShare === null ? null : colour(greenShare),
        claims,
      };
    });

  return { subjectId: input.subjectId, subjectName: input.subjectName, students: input.students, minStudents: min, topics };
}

export interface MisunderstoodCandidate { claimId: string; text: string; topicName: string; wrong: number; wrongMarks: number; attempted: number; sourceId: string | null; page: number | null }

/** Claims most often marked wrong, only from unsuppressed topics and with at least MIN_WRONG_STUDENTS students. */
export function pickMostMisunderstood(heatmap: ClassHeatmap, claimCounts: ClaimCount[], limit = 5): MisunderstoodCandidate[] {
  const marks = new Map(claimCounts.map((c) => [c.claim_id, Number(c.wrong_marks ?? c.wrong ?? 0)]));
  const out: MisunderstoodCandidate[] = [];
  for (const t of heatmap.topics) {
    if (t.suppressed) continue;
    for (const c of t.claims) {
      if (c.wrong === null || c.wrong < MIN_WRONG_STUDENTS) continue;
      out.push({ claimId: c.claimId, text: c.text, topicName: t.name, wrong: c.wrong, wrongMarks: marks.get(c.claimId) ?? c.wrong, attempted: t.attempted, sourceId: c.sourceId, page: c.page });
    }
  }
  return out.sort((a, b) => b.wrong / b.attempted - a.wrong / a.attempted || b.wrong - a.wrong || b.wrongMarks - a.wrongMarks).slice(0, limit);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Strip anything identifying from free text: member names, emails, phone-like numbers, urls, @handles. */
export function anonymise(text: string, names: string[]): string {
  let t = text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[someone]")
    .replace(/https?:\/\/\S+/g, "[link]")
    .replace(/@\w+/g, "[someone]")
    .replace(/\+?\d[\d\s-]{7,}\d/g, "[number]");
  const parts = new Set<string>();
  for (const n of names) {
    const full = n.trim();
    if (full.length >= 2) parts.add(full);
    for (const p of full.split(/\s+/)) if (p.length >= 3) parts.add(p);
  }
  for (const p of [...parts].sort((a, b) => b.length - a.length)) {
    t = t.replace(new RegExp(`\\b${escapeRe(p)}\\b`, "gi"), "[someone]");
  }
  return t.replace(/\s+/g, " ").trim();
}

const trimSentence = (s: string) => s.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);

export interface PhraseCount { text: string; n: number }

/** Offline one-sentence misconception summary. Only quotes a student phrase shared by MIN_SHARED_PHRASE+ students. */
export function fallbackMisconception(claimText: string, corrections: PhraseCount[], phrases: PhraseCount[], names: string[]): string {
  const correction = corrections.find((c) => c.text.trim())?.text ?? claimText;
  const notes = lowerFirst(trimSentence(anonymise(correction, names)).replace(/^(actually|no|wrong|incorrect)[,:]?\s*/i, ""));
  const shared = phrases.find((p) => p.n >= MIN_SHARED_PHRASE && p.text.trim().length > 3);
  if (shared) {
    const think = trimSentence(anonymise(shared.text, names)).slice(0, 140);
    return `Many students think "${think}"; the notes say ${notes}.`;
  }
  return `Many students get this wrong; the notes say ${notes}.`;
}

/** Collect every user id / name we must never output, for leak checks. */
export function containsAny(haystack: string, needles: string[]): string | null {
  for (const n of needles) if (n && haystack.includes(n)) return n;
  return null;
}
