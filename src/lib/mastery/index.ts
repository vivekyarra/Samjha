// Samjha mastery, FSRS scheduling, heatmaps, review queue and streaks (spec F5, F6, F12 streaks).
import "server-only";
import { all, get, run } from "@/lib/db";
import type { AttemptKind, ClaimGrade, ClaimStatus, Mastery, Subject } from "@/lib/types";
import {
  countMastery,
  effectiveMastery,
  greenPercent,
  masteryAfterGrade,
  rankTopics,
  reasonFor,
  reviewMinutes,
  scheduleCard,
  streakFromDates,
  topicColour,
  type TopicCounts,
} from "./rules";

export { topicColour, effectiveMastery, masteryAfterGrade, ratingFor, rankTopics, reasonFor } from "./rules";

interface CardRow { claim_id: string; fsrs_state: string | null; due_at: string | null; mastery: Mastery }

const EXPLAIN_KINDS: AttemptKind[] = ["explain", "explain_back", "review"];

// ---------- writes ----------

/**
 * Update FSRS cards + stored mastery for one graded attempt. Returns the new effective mastery per claim.
 * Not wrapped in a transaction so callers may run it inside their own `tx()`.
 */
export async function recordGrades(
  userId: string,
  attemptId: string,
  kind: AttemptKind,
  grades: ClaimGrade[],
  opts: { afterBuddy: boolean } = { afterBuddy: false },
): Promise<Record<string, Mastery>> {
  const t = new Date();
  const ts = t.toISOString();
  const out: Record<string, Mastery> = {};
  for (const g of grades) {
    if (!g?.claim_id) continue;
    const prev = await get<CardRow>("SELECT claim_id, fsrs_state, due_at, mastery FROM claim_cards WHERE user_id=? AND claim_id=?", userId, g.claim_id);
    const { stateJson, dueAt } = scheduleCard(prev?.fsrs_state, g.status, opts.afterBuddy, t);
    const mastery = masteryAfterGrade(g.status, kind, opts.afterBuddy);
    await run(
      `INSERT INTO claim_cards (user_id, claim_id, fsrs_state, due_at, mastery, updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(user_id, claim_id) DO UPDATE SET fsrs_state=excluded.fsrs_state, due_at=excluded.due_at, mastery=excluded.mastery, updated_at=excluded.updated_at`,
      userId, g.claim_id, stateJson, dueAt, mastery, ts,
    );
    out[g.claim_id] = effectiveMastery(mastery, dueAt, t);
  }
  return out;
}

// ---------- reads ----------

export async function getUserSubjects(userId: string): Promise<Subject[]> {
  return all<Subject>(
    `SELECT s.* FROM subjects s JOIN subject_members m ON m.subject_id = s.id WHERE m.user_id = ? ORDER BY s.created_at DESC`,
    userId,
  );
}

export async function getClaimMastery(userId: string, claimIds: string[]): Promise<Record<string, Mastery>> {
  const out: Record<string, Mastery> = {};
  if (!claimIds.length) return out;
  for (const id of claimIds) out[id] = "red";
  const t = new Date();
  // chunk to stay well under SQLite's parameter limit
  for (let i = 0; i < claimIds.length; i += 500) {
    const ids = claimIds.slice(i, i + 500);
    const rows = await all<CardRow>(
      `SELECT claim_id, fsrs_state, due_at, mastery FROM claim_cards WHERE user_id=? AND claim_id IN (${ids.map(() => "?").join(",")})`,
      userId, ...ids,
    );
    for (const r of rows) out[r.claim_id] = effectiveMastery(r.mastery, r.due_at, t);
  }
  return out;
}

export interface HeatmapTopic {
  id: string;
  name: string;
  position: number;
  inExam: boolean;
  mastery: Mastery;
  greenPct: number;
  counts: TopicCounts;
  due: number;
  dependants: number;
  dependsOn: number;
}

export interface SubjectHeatmap {
  subject: { id: string; name: string; examDate: string | null; isShared: boolean };
  topics: HeatmapTopic[];
  summary: TopicCounts & { topics: number; due: number; greenPct: number };
}

interface TopicClaimRow {
  topic_id: string;
  topic_name: string;
  position: number;
  in_exam: number;
  claim_id: string | null;
  mastery: Mastery | null;
  due_at: string | null;
}

export async function subjectHeatmap(userId: string, subjectId: string): Promise<SubjectHeatmap | null> {
  const subject = await get<Subject>("SELECT * FROM subjects WHERE id=?", subjectId);
  if (!subject) return null;
  const rows = await all<TopicClaimRow>(
    `SELECT t.id AS topic_id, t.name AS topic_name, t.position, t.in_exam, c.id AS claim_id, cc.mastery, cc.due_at
       FROM topics t
       LEFT JOIN claims c ON c.topic_id = t.id
       LEFT JOIN claim_cards cc ON cc.claim_id = c.id AND cc.user_id = ?
      WHERE t.subject_id = ?
      ORDER BY t.position, t.name`,
    userId, subjectId,
  );
  const deps = await all<{ topic_id: string; depends_on_topic_id: string }>(
    `SELECT p.topic_id, p.depends_on_topic_id FROM prerequisites p JOIN topics t ON t.id = p.topic_id WHERE t.subject_id = ?`,
    subjectId,
  );
  const dependants = new Map<string, number>();
  const dependsOn = new Map<string, number>();
  for (const d of deps) {
    dependants.set(d.depends_on_topic_id, (dependants.get(d.depends_on_topic_id) ?? 0) + 1);
    dependsOn.set(d.topic_id, (dependsOn.get(d.topic_id) ?? 0) + 1);
  }

  const t = new Date();
  const byTopic = new Map<string, { row: TopicClaimRow; ms: Mastery[]; due: number }>();
  for (const r of rows) {
    let e = byTopic.get(r.topic_id);
    if (!e) byTopic.set(r.topic_id, (e = { row: r, ms: [], due: 0 }));
    if (!r.claim_id) continue;
    const m = effectiveMastery(r.mastery, r.due_at, t);
    e.ms.push(m);
    if (isDue(r.mastery, r.due_at, t)) e.due++;
  }

  const topics: HeatmapTopic[] = [...byTopic.values()].map(({ row, ms, due }) => {
    const counts = countMastery(ms);
    const pct = greenPercent(counts);
    return {
      id: row.topic_id,
      name: row.topic_name,
      position: row.position,
      inExam: !!row.in_exam,
      mastery: topicColour(counts.total ? counts.green / counts.total : 0),
      greenPct: pct,
      counts,
      due,
      dependants: dependants.get(row.topic_id) ?? 0,
      dependsOn: dependsOn.get(row.topic_id) ?? 0,
    };
  });
  const total: TopicCounts = { red: 0, amber: 0, green: 0, total: 0 };
  for (const x of topics) for (const k of ["red", "amber", "green", "total"] as const) total[k] += x.counts[k];
  return {
    subject: { id: subject.id, name: subject.name, examDate: subject.exam_date, isShared: !!subject.is_shared },
    topics,
    summary: { ...total, topics: topics.length, due: topics.reduce((a, x) => a + x.due, 0), greenPct: greenPercent(total) },
  };
}

export async function allHeatmaps(userId: string): Promise<SubjectHeatmap[]> {
  const maps = await Promise.all((await getUserSubjects(userId)).map((s) => subjectHeatmap(userId, s.id)));
  return maps.filter((h): h is SubjectHeatmap => !!h);
}

function isDue(stored: Mastery | null, dueAt: string | null, t: Date) {
  return !!stored && stored !== "red" && !!dueAt && new Date(dueAt).getTime() <= t.getTime();
}

export interface DueTopic { topicId: string; name: string; subjectId: string; subjectName: string; claimIds: string[] }
export interface DueToday { topics: DueTopic[]; total: number; minutes: number }

/** Claims due for review (previously covered, FSRS due date passed), grouped by topic. */
export async function dueToday(userId: string): Promise<DueToday> {
  const t = new Date();
  const rows = await all<{ claim_id: string; topic_id: string; topic_name: string; subject_id: string; subject_name: string; due_at: string; mastery: Mastery }>(
    `SELECT cc.claim_id, cc.due_at, cc.mastery, t.id AS topic_id, t.name AS topic_name, s.id AS subject_id, s.name AS subject_name
       FROM claim_cards cc
       JOIN claims c ON c.id = cc.claim_id
       JOIN topics t ON t.id = c.topic_id
       JOIN subjects s ON s.id = t.subject_id
       JOIN subject_members m ON m.subject_id = s.id AND m.user_id = cc.user_id
      WHERE cc.user_id = ? AND cc.mastery != 'red' AND cc.due_at IS NOT NULL AND cc.due_at <= ?
      ORDER BY cc.due_at, t.position, c.position`,
    userId, t.toISOString(),
  );
  const map = new Map<string, DueTopic>();
  for (const r of rows) {
    let e = map.get(r.topic_id);
    if (!e) map.set(r.topic_id, (e = { topicId: r.topic_id, name: r.topic_name, subjectId: r.subject_id, subjectName: r.subject_name, claimIds: [] }));
    e.claimIds.push(r.claim_id);
  }
  const topics = [...map.values()];
  const total = rows.length;
  return { topics, total, minutes: reviewMinutes(total) };
}

export interface NextToStudy { topicId: string; name: string; subjectId: string; subjectName: string; mastery: Mastery; reason: string }

/** Highest-priority topic to study now: red first, then by dependants, exam flag, then amber. */
export async function nextToStudy(userId: string, subjectId?: string): Promise<NextToStudy | null> {
  const maps = subjectId ? [await subjectHeatmap(userId, subjectId)].filter((h): h is SubjectHeatmap => !!h) : await allHeatmaps(userId);
  const candidates = maps.flatMap((h) =>
    h.topics.filter((x) => x.counts.total > 0).map((x) => ({ ...x, subjectId: h.subject.id, subjectName: h.subject.name })),
  );
  const top = rankTopics(candidates)[0];
  if (!top) return null;
  return { topicId: top.id, name: top.name, subjectId: top.subjectId, subjectName: top.subjectName, mastery: top.mastery, reason: reasonFor(top) };
}

async function userTimeZone(userId: string): Promise<string | undefined> {
  const row = await get<{ json: string }>("SELECT json FROM settings WHERE user_id=?", userId);
  if (!row) return undefined;
  try {
    const tz = (JSON.parse(row.json) as { nudges?: { timezone?: string } })?.nudges?.timezone;
    return typeof tz === "string" && tz ? tz : undefined;
  } catch {
    return undefined;
  }
}

/** Full streak info: current days, whether today counts yet, longest ever. */
export async function streakInfo(userId: string): Promise<{ days: number; today: boolean; longest: number }> {
  const rows = await all<{ created_at: string }>(
    `SELECT created_at FROM attempts WHERE user_id=? AND kind IN (${EXPLAIN_KINDS.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 2000`,
    userId, ...EXPLAIN_KINDS,
  );
  return streakFromDates(rows.map((r) => r.created_at), new Date(), await userTimeZone(userId));
}

/** Consecutive local days (ending today or yesterday) with ≥1 explanation. */
export async function streak(userId: string): Promise<number> {
  return (await streakInfo(userId)).days;
}

export interface SessionSummary {
  topicId: string | null;
  attempts: number;
  claimsFixed: number;
  claimsTotal: number;
  covered: number;
  fixedClaimIds: string[];
  stillMissing: string[];
  durationMs: number;
  minutes: number;
  streak: number;
}

/** Summary across a session's attempts (first → last): which claims flipped to covered, time spent, streak. */
export async function sessionSummary(attemptIds: string[]): Promise<SessionSummary> {
  const empty: SessionSummary = { topicId: null, attempts: 0, claimsFixed: 0, claimsTotal: 0, covered: 0, fixedClaimIds: [], stillMissing: [], durationMs: 0, minutes: 0, streak: 0 };
  if (!attemptIds.length) return empty;
  const attempts = await all<{ id: string; user_id: string; topic_id: string | null; created_at: string }>(
    `SELECT id, user_id, topic_id, created_at FROM attempts WHERE id IN (${attemptIds.map(() => "?").join(",")}) ORDER BY created_at`,
    ...attemptIds,
  );
  if (!attempts.length) return empty;
  const results = await all<{ attempt_id: string; claim_id: string; status: ClaimStatus }>(
    `SELECT attempt_id, claim_id, status FROM claim_results WHERE attempt_id IN (${attempts.map(() => "?").join(",")})`,
    ...attempts.map((a) => a.id),
  );
  const order = new Map(attempts.map((a, i) => [a.id, i]));
  const first = new Map<string, { i: number; s: ClaimStatus }>();
  const last = new Map<string, { i: number; s: ClaimStatus }>();
  for (const r of results) {
    const i = order.get(r.attempt_id) ?? 0;
    const f = first.get(r.claim_id);
    if (!f || i < f.i) first.set(r.claim_id, { i, s: r.status });
    const l = last.get(r.claim_id);
    if (!l || i >= l.i) last.set(r.claim_id, { i, s: r.status });
  }
  const fixed: string[] = [];
  const still: string[] = [];
  let covered = 0;
  for (const [id, l] of last) {
    if (l.s === "covered") {
      covered++;
      if (first.get(id)?.s !== "covered") fixed.push(id);
    } else still.push(id);
  }
  const userId = attempts[0].user_id;
  const start = new Date(attempts[0].created_at).getTime();
  const end = Math.max(new Date(attempts[attempts.length - 1].created_at).getTime(), Date.now());
  const durationMs = Math.max(0, Math.min(end - start, 6 * 60 * 60 * 1000));
  return {
    topicId: attempts[0].topic_id,
    attempts: attempts.length,
    claimsFixed: fixed.length,
    claimsTotal: last.size,
    covered,
    fixedClaimIds: fixed,
    stillMissing: still,
    durationMs,
    minutes: Math.max(1, Math.round(durationMs / 60000)),
    streak: await streak(userId),
  };
}

/** Convenience for other modules: effective mastery for every claim of a topic + the topic colour. */
export async function topicMastery(userId: string, topicId: string): Promise<{ mastery: Mastery; greenPct: number; claims: Record<string, Mastery> }> {
  const ids = (await all<{ id: string }>("SELECT id FROM claims WHERE topic_id=? ORDER BY position", topicId)).map((r) => r.id);
  const claims = await getClaimMastery(userId, ids);
  const counts = countMastery(Object.values(claims));
  return { mastery: topicColour(counts.total ? counts.green / counts.total : 0), greenPct: greenPercent(counts), claims };
}
