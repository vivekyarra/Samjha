// Prepares the "Intro to Machine Learning" sample workspace (spec F14). Used by /demo, onboarding "use sample notes"
// and scripts/prepare-sample.ts. Fully synchronous + one transaction so /demo stays well under 2s.
import "server-only";
import { all, get, run, tx, newId, now, insertMany } from "@/lib/db";
import { embed } from "@/lib/ingest";
import { scheduleCard, masteryAfterGrade } from "@/lib/mastery/rules";
import type { AttemptKind, ClaimGrade, ClaimStatus, GradeResult } from "@/lib/types";
import {
  DEMO_FILE_NAME, DEMO_PAGES, DEMO_PREREQS, DEMO_SUBJECT_NAME, DEMO_TOPICS,
  DEMO_SUGGESTED_EXPLANATION, genericSuggestion,
} from "./content";

export { DEMO_SUGGESTED_EXPLANATION, DEMO_SUBJECT_NAME } from "./content";

export interface SampleResult { subjectId: string; topicIds: Record<string, string> }
export interface SampleOptions {
  /** Past study history (attempts + FSRS cards) for this user so the heatmap is partly red/amber/green. Default true. */
  history?: boolean;
  /** Anonymous classmates (is_demo users) who joined and attempted, so the class heatmap has data. Default true. */
  classmates?: boolean;
}

const DAY = 86_400_000;
type S = "c" | "m" | "w";
const STATUS: Record<S, ClaimStatus> = { c: "covered", m: "missing", w: "wrong" };

/** Common wrong statements per [topicKey, claimIndex], so the class "most misunderstood" list reads naturally. */
const MISCONCEPTIONS: Record<string, string> = {
  "gd:2": "we move in the direction of the gradient to reduce the loss",
  "backprop:2": "the error is passed forward from the input layer to the output layer",
  "overfit:1": "an overfit model has high training error too",
  "chain:1": "you add the derivatives together",
  "lr:2": "a bigger learning rate always reaches a better minimum",
  "loss:4": "accuracy is the loss we minimise during training",
  "nn:2": "all weights start at zero",
  "act:0": "stacking linear layers already makes the model non-linear",
};

/** Main guest student's history: topicKey → attempts (oldest first). */
const HISTORY: Record<string, { daysAgo: number; kind: AttemptKind; afterBuddy?: boolean; s: S[] }[]> = {
  loss: [
    { daysAgo: 6, kind: "explain", s: ["c", "c", "c", "m", "c"] },
    { daysAgo: 6, kind: "explain_back", afterBuddy: true, s: ["c", "c", "c", "c", "c"] },
  ],
  nn: [{ daysAgo: 5, kind: "explain", s: ["c", "c", "c", "c", "c"] }],
  lr: [
    { daysAgo: 4, kind: "explain", s: ["c", "w", "c", "m", "m"] },
    { daysAgo: 4, kind: "explain_back", afterBuddy: true, s: ["c", "c", "c", "c", "m"] },
  ],
  split: [
    { daysAgo: 3, kind: "explain", s: ["c", "c", "c", "m", "m"] },
    { daysAgo: 3, kind: "explain_back", afterBuddy: true, s: ["c", "c", "c", "c", "c"] },
  ],
  overfit: [{ daysAgo: 3, kind: "explain", s: ["c", "c", "c", "m", "c"] }],
  act: [{ daysAgo: 2, kind: "explain", s: ["c", "c", "m", "c", "w"] }],
  chain: [{ daysAgo: 2, kind: "explain", s: ["w", "m", "c", "m", "m"] }],
  gd: [{ daysAgo: 1, kind: "explain", s: ["c", "m", "w", "m", "m", "m"] }],
  backprop: [{ daysAgo: 1, kind: "explain", s: ["c", "m", "w", "m", "m"] }],
  // reg: never attempted (red, no cards)
};
/** Claims whose review is overdue (stored green, shows amber). */
const OVERDUE: [string, number][] = [["overfit", 0], ["overfit", 1], ["nn", 4]];

/** Classmate covered-probability per topic; topics missing here are attempted by only 3 classmates (stay hidden < 5). */
const CLASS_DIFFICULTY: Record<string, number> = { loss: 0.78, nn: 0.8, lr: 0.6, gd: 0.45, chain: 0.4, backprop: 0.32, overfit: 0.62 };
const CLASSMATES = 6;

function rng(start: number) {
  let s = start >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function chunkPage(text: string): string[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length > 700) {
      out.push(cur);
      cur = p;
    } else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

interface SampleClaim { id: string; text: string; page: number }

// Everything for the sample workspace is built in memory and written with a few multi-row inserts,
// so setup stays fast even when the database is across the network.
type Rows = Record<string, unknown[][]>;
interface Card { fsrs_state: string | null; due_at: string | null; mastery: string; updated_at: string }

function recordAttempt(
  rows: Rows, cards: Map<string, Card>,
  userId: string, topicId: string, claims: SampleClaim[], kind: AttemptKind, statuses: ClaimStatus[],
  at: Date, afterBuddy: boolean, topicKey: string, parentAttemptId: string | null,
): string {
  const attemptId = newId("a_");
  const grades: ClaimGrade[] = claims.map((c, i) => {
    const status = statuses[i] ?? "missing";
    const mis = MISCONCEPTIONS[`${topicKey}:${i}`];
    return {
      claim_id: c.id,
      status,
      evidence: status === "covered" ? c.text.split(/[,:;]/)[0].toLowerCase() : status === "wrong" ? (mis ?? "") : "",
      correction: status === "wrong" ? c.text : "",
      page: c.page,
    };
  });
  const transcript = grades
    .map((g) => g.evidence)
    .filter(Boolean)
    .join(". ");
  const result: GradeResult = {
    claims: grades,
    misconceptions: [],
    strengths: grades.some((g) => g.status === "covered") ? ["You explained the core idea in your own words."] : [],
  };
  const ts = at.toISOString();
  rows.attempts.push([attemptId, userId, topicId, kind, transcript ? transcript + "." : "", JSON.stringify({ ...result, sample: true }), parentAttemptId, ts]);
  for (const g of grades) {
    rows.claim_results.push([newId("cr_"), attemptId, g.claim_id, g.status, g.evidence, g.correction]);
    const key = `${userId}|${g.claim_id}`;
    const { stateJson, dueAt } = scheduleCard(cards.get(key)?.fsrs_state, g.status, afterBuddy, at);
    cards.set(key, { fsrs_state: stateJson, due_at: dueAt, mastery: masteryAfterGrade(g.status, kind, afterBuddy), updated_at: ts });
  }
  return attemptId;
}

function joinCode(): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

// Insert order respects foreign keys.
const COLUMNS: Record<string, string[]> = {
  users: ["id", "name", "email", "language", "is_demo", "onboarded", "created_at"],
  subjects: ["id", "owner_id", "name", "exam_date", "is_shared", "join_code", "created_at"],
  subject_members: ["subject_id", "user_id", "role"],
  sources: ["id", "subject_id", "file_name", "storage_path", "mime", "pages", "url", "content_hash", "created_at"],
  chunks: ["id", "source_id", "page", "text", "embedding"],
  topics: ["id", "subject_id", "name", "position", "in_exam"],
  claims: ["id", "topic_id", "text", "source_id", "page", "position"],
  prerequisites: ["topic_id", "depends_on_topic_id"],
  attempts: ["id", "user_id", "topic_id", "kind", "transcript", "result_json", "parent_attempt_id", "created_at"],
  claim_results: ["id", "attempt_id", "claim_id", "status", "evidence", "correction"],
  claim_cards: ["user_id", "claim_id", "fsrs_state", "due_at", "mastery", "updated_at"],
};

/** Create the sample ML subject for `userId`. Returns the subject id and topic ids keyed by topic name. */
export async function prepareSampleSubject(userId: string, opts: SampleOptions = {}): Promise<SampleResult> {
  const withHistory = opts.history ?? true;
  const withClassmates = opts.classmates ?? true;
  const t0 = Date.now();
  const ts = now();
  const rows: Rows = Object.fromEntries(Object.keys(COLUMNS).map((t) => [t, [] as unknown[][]]));
  const cards = new Map<string, Card>();

  const subjectId = newId("s_");
  rows.subjects.push([subjectId, userId, DEMO_SUBJECT_NAME, new Date(t0 + 12 * DAY).toISOString().slice(0, 10),
    withClassmates ? 1 : 0, withClassmates ? joinCode() : null, ts]);
  rows.subject_members.push([subjectId, userId, "owner"]);

  const sourceId = newId("src_");
  rows.sources.push([sourceId, subjectId, DEMO_FILE_NAME, null, "application/pdf", DEMO_PAGES.length, null, "demo-ml-v1", ts]);
  DEMO_PAGES.forEach((p, i) => {
    for (const text of chunkPage(p)) rows.chunks.push([newId("ch_"), sourceId, i + 1, text, JSON.stringify(embed(text))]);
  });

  const topicIds: Record<string, string> = {};
  const byKey: Record<string, { id: string; claims: SampleClaim[] }> = {};
  for (const [ti, t] of DEMO_TOPICS.entries()) {
    const id = newId("t_");
    rows.topics.push([id, subjectId, t.name, ti, t.key === "gd" || t.key === "backprop" ? 1 : 0]);
    const claims: SampleClaim[] = [];
    for (const [ci, c] of t.claims.entries()) {
      const cid = newId("c_");
      rows.claims.push([cid, id, c.text, sourceId, c.page, ci]);
      claims.push({ id: cid, text: c.text, page: c.page });
    }
    topicIds[t.name] = id;
    byKey[t.key] = { id, claims };
  }
  for (const [a, b] of DEMO_PREREQS) rows.prerequisites.push([byKey[a].id, byKey[b].id]);

  if (withHistory) {
    for (const [key, attempts] of Object.entries(HISTORY)) {
      const topic = byKey[key];
      let parent: string | null = null;
      for (const [i, a] of attempts.entries()) {
        const at = new Date(t0 - a.daysAgo * DAY + i * 6 * 60_000 - 3 * 3_600_000);
        const id = recordAttempt(rows, cards, userId, topic.id, topic.claims, a.kind, a.s.map((x) => STATUS[x]), at, !!a.afterBuddy, key, parent);
        if (a.kind === "explain") parent = id;
      }
    }
  }

  if (withClassmates) {
    const rand = rng(t0 % 100000);
    for (let n = 0; n < CLASSMATES; n++) {
      const mateId = newId("u_");
      rows.users.push([mateId, `Classmate ${n + 1}`, null, "English", 1, 1, ts]);
      rows.subject_members.push([subjectId, mateId, "member"]);
      for (const t of DEMO_TOPICS) {
        const p = CLASS_DIFFICULTY[t.key];
        if (p === undefined && n >= 3) continue; // only 3 classmates tried these: stays below the 5-student minimum
        const pc = p ?? 0.6;
        const topic = byKey[t.key];
        const statuses = topic.claims.map((_, i): ClaimStatus => {
          const r = rand();
          if (MISCONCEPTIONS[`${t.key}:${i}`] && r < 0.45) return "wrong";
          if (r < 0.45 + pc * 0.55) return rand() < pc ? "covered" : "missing";
          return rand() < 0.15 ? "wrong" : "missing";
        });
        const at = new Date(t0 - (1 + Math.floor(rand() * 6)) * DAY - Math.floor(rand() * 8) * 3_600_000);
        recordAttempt(rows, cards, mateId, topic.id, topic.claims, "explain", statuses, at, false, t.key, null);
      }
    }
  }
  // Same-day learning steps put fresh cards due within minutes; spread green reviews over the coming days instead,
  // then mark the chosen claims overdue so they show amber.
  for (const c of cards.values()) {
    if (c.mastery === "green") c.due_at = new Date(Date.now() + (2 + Math.floor(Math.random() * 8)) * DAY).toISOString();
  }
  if (withHistory) {
    const past = new Date(t0 - DAY).toISOString();
    for (const [key, idx] of OVERDUE) {
      const c = byKey[key].claims[idx];
      const card = c && cards.get(`${userId}|${c.id}`);
      if (card) card.due_at = past;
    }
  }
  for (const [key, c] of cards) {
    const [u, claimId] = key.split("|");
    rows.claim_cards.push([u, claimId, c.fsrs_state, c.due_at, c.mastery, c.updated_at]);
  }

  await tx(async () => {
    for (const [table, cols] of Object.entries(COLUMNS)) await insertMany(table, cols, rows[table]);
  });
  return { subjectId, topicIds };
}

/** The sample subject this user already owns, if any (so "use sample notes" is idempotent). */
export async function findSampleSubject(userId: string): Promise<SampleResult | null> {
  const s = await get<{ id: string }>("SELECT id FROM subjects WHERE owner_id=? AND name=? ORDER BY created_at DESC LIMIT 1", userId, DEMO_SUBJECT_NAME);
  if (!s) return null;
  const topics = await all<{ id: string; name: string }>("SELECT id, name FROM topics WHERE subject_id=?", s.id);
  return { subjectId: s.id, topicIds: Object.fromEntries(topics.map((t) => [t.name, t.id])) };
}

/** Delete demo users (and, by cascade, their subjects, attempts, cards) older than `maxAgeMs`. */
export async function cleanupDemo(maxAgeMs = 3_600_000): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  return Number((await run("DELETE FROM users WHERE is_demo=1 AND created_at < ?", cutoff)).changes);
}

/** Suggested (deliberately imperfect) explanation for a topic: hand-written for key topics, generated otherwise. */
export function suggestionFor(topicName: string, claimTexts: string[]): string {
  const key = Object.keys(DEMO_SUGGESTED_EXPLANATION).find((k) => k.toLowerCase() === topicName.trim().toLowerCase());
  return key ? DEMO_SUGGESTED_EXPLANATION[key] : genericSuggestion(topicName, claimTexts);
}
