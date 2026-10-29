// Exam-eve mode (spec F7): a timed crash session over red/amber claims only, in priority order.
import "server-only";
import { z } from "zod";
import { all, get, run, tx, newId, now } from "@/lib/db";
import { hasAI, aiJSON } from "@/lib/ai";
import {
  loadGraph, topicMasteries, prereqMap, dependantCounts, claimToQuestion, saveGradedAttempt, safeGrade, type TopicState,
} from "@/lib/graph";
import type { Mastery } from "@/lib/types";

export type Budget = 5 | 10 | 20;
export const BUDGETS: Budget[] = [5, 10, 20];

const WPM = 150;
const CHECK_SEC = 45;
const WORDS_PER_CLAIM = 35;
const WORDS_OVERHEAD = 20;
const MAX_WORDS = 130;

export interface GapClaim { id: string; text: string; mastery: Mastery; page: number | null; source_id: string | null }
export interface PlanTopic {
  topicId: string; name: string; subjectId: string; subjectName: string;
  mastery: TopicState; inExam: boolean; dependants: number;
  gapClaims: GapClaim[]; allocSec: number; reason: string;
}
export interface ExamEvePlan {
  budgetMin: Budget;
  totalSec: number;
  topics: PlanTopic[];
  skipped: { topicId: string; name: string }[];
  subjects: { id: string; name: string }[];
}

export const topicSeconds = (claims: number) =>
  Math.round((Math.min(MAX_WORDS, WORDS_OVERHEAD + WORDS_PER_CLAIM * claims) / WPM) * 60 + CHECK_SEC);

export async function userSubjects(userId: string) {
  return all<{ id: string; name: string; exam_date: string | null }>(
    "SELECT s.id, s.name, s.exam_date FROM subjects s JOIN subject_members m ON m.subject_id=s.id WHERE m.user_id=? ORDER BY s.created_at",
    userId,
  );
}

export async function planExamEve(userId: string, subjectId: string | null, budgetMin: Budget): Promise<ExamEvePlan> {
  const subjects = await userSubjects(userId);
  const chosen = subjectId ? subjects.filter((s) => s.id === subjectId) : subjects;
  const candidates: (Omit<PlanTopic, "allocSec"> & { score: number })[] = [];

  for (const s of chosen) {
    const g = await loadGraph(s.id);
    const tm = await topicMasteries(userId, g.topics);
    const { rev } = prereqMap(g.prerequisites);
    const dc = dependantCounts(g.topics.map((t) => t.id), rev);
    for (const t of g.topics) {
      const m = tm[t.id];
      const gaps = m.claims.filter((c) => c.mastery !== "green");
      if (!gaps.length) continue;
      gaps.sort((a, b) => (a.mastery === b.mastery ? 0 : a.mastery === "red" ? -1 : 1));
      const hasRed = gaps.some((c) => c.mastery === "red");
      const tier: TopicState = m.mastery === "green" ? "amber" : m.mastery;
      const reasons = [hasRed ? "red claims" : "amber claims"];
      if (dc[t.id]) reasons.push(`${dc[t.id]} topic${dc[t.id] > 1 ? "s" : ""} build on it`);
      if (t.in_exam) reasons.push("you flagged it for the exam");
      candidates.push({
        topicId: t.id, name: t.name, subjectId: s.id, subjectName: s.name, mastery: tier, inExam: !!t.in_exam,
        dependants: dc[t.id] ?? 0, gapClaims: gaps.map(({ id, text, mastery, page, source_id }) => ({ id, text, mastery, page, source_id })),
        reason: reasons.join(", "),
        score: (hasRed ? 1000 : 0) + (t.in_exam ? 400 : 0) + Math.min(dc[t.id] ?? 0, 20) * 15 + (gaps.length / Math.max(1, m.claims.length)) * 10,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const budgetSec = budgetMin * 60;
  const picked: PlanTopic[] = [];
  const skipped: { topicId: string; name: string }[] = [];
  let used = 0;
  for (const c of candidates) {
    const left = budgetSec - used;
    let gaps = c.gapClaims;
    while (gaps.length > 1 && topicSeconds(gaps.length) > left) gaps = gaps.slice(0, -1);
    const cost = topicSeconds(gaps.length);
    if (cost > left) { skipped.push({ topicId: c.topicId, name: c.name }); continue; }
    used += cost;
    const { score: _score, ...rest } = c;
    void _score;
    picked.push({ ...rest, gapClaims: gaps, allocSec: cost });
  }
  // spread spare time (up to 1.5x each) so the session fills, but never exceeds, the budget
  const spare = budgetSec - used;
  if (picked.length && spare > 0) {
    const factor = Math.min(1.5, budgetSec / used);
    for (const p of picked) p.allocSec = Math.floor(p.allocSec * factor);
  }
  return {
    budgetMin,
    totalSec: picked.reduce((a, p) => a + p.allocSec, 0),
    topics: picked,
    skipped,
    subjects: subjects.map(({ id, name }) => ({ id, name })),
  };
}

/** Creates the exam_eve attempt the buddy explains from: the chosen gap claims are marked missing. */
export async function startTopicAttempt(userId: string, topicId: string, claimIds: string[]): Promise<string> {
  const valid = (await all<{ id: string }>(
    `SELECT id FROM claims WHERE topic_id=? AND id IN (${claimIds.map(() => "?").join(",") || "''"})`, topicId, ...claimIds,
  )).map((r) => r.id);
  const attemptId = newId("a_");
  await tx(async () => {
    await run(
      "INSERT INTO attempts (id,user_id,topic_id,kind,transcript,result_json,created_at) VALUES (?,?,?,?,?,?,?)",
      attemptId, userId, topicId, "exam_eve", "",
      JSON.stringify({ examEveGaps: true, claims: valid.map((id) => ({ claim_id: id, status: "missing", evidence: "", correction: "", page: null })), misconceptions: [], strengths: [] }),
      now(),
    );
    for (const id of valid) {
      await run("INSERT INTO claim_results (id,attempt_id,claim_id,status,evidence,correction) VALUES (?,?,?,?,?,?)", newId("cr_"), attemptId, id, "missing", "", "");
    }
  });
  return attemptId;
}

export async function checkQuestion(topicId: string, claimIds: string[]): Promise<{ question: string; claimId: string | null }> {
  const topic = await get<{ name: string }>("SELECT name FROM topics WHERE id=?", topicId);
  const name = topic?.name ?? "this topic";
  const claims = claimIds.length
    ? await all<{ id: string; text: string }>(`SELECT id, text FROM claims WHERE topic_id=? AND id IN (${claimIds.map(() => "?").join(",")})`, topicId, ...claimIds)
    : await all<{ id: string; text: string }>("SELECT id, text FROM claims WHERE topic_id=? ORDER BY position LIMIT 1", topicId);
  const ordered = claimIds.length ? claimIds.map((id) => claims.find((c) => c.id === id)).filter((c): c is { id: string; text: string } => !!c) : claims;
  const target = ordered[0];
  if (!target) return { question: `In one line, what is ${name} about?`, claimId: null };
  const fallback = { question: claimToQuestion(target.text, name), claimId: target.id };
  if (!hasAI()) return fallback;
  try {
    const r = await aiJSON(
      {
        model: "fast", cache: true, maxTokens: 200,
        system: "Write ONE quick spoken check question (max 18 words) whose correct answer is the given note line. Answerable in one sentence. Do not reveal the answer.",
        user: JSON.stringify({ topic: name, note: target.text, output: { question: "string" } }),
      },
      z.object({ question: z.string().min(5).max(200) }),
    );
    return { question: r.question, claimId: target.id };
  } catch {
    return fallback;
  }
}

/** Grades a spoken check answer; returns one line of feedback and updates mastery. */
export async function gradeCheck(opts: { userId: string; topicId: string; claimId: string | null; answer: string; parentAttemptId?: string | null }) {
  const claim = opts.claimId ? await get<{ id: string; text: string; page: number | null }>("SELECT id, text, page FROM claims WHERE id=? AND topic_id=?", opts.claimId, opts.topicId) : undefined;
  if (!claim) return { status: "covered" as const, feedback: "Got it. Moving on." };
  const [g] = await safeGrade({ userId: opts.userId, topicId: opts.topicId, explanation: opts.answer, claims: [claim] });
  await saveGradedAttempt({
    userId: opts.userId, topicId: opts.topicId, kind: "exam_eve", transcript: opts.answer, grades: [g],
    afterBuddy: true, parentAttemptId: opts.parentAttemptId ?? null, extra: { examEveCheck: true },
  });
  const short = (s: string) => (s.length > 160 ? s.slice(0, 157).replace(/\s+\S*$/, "") + "…" : s);
  const feedback = g.status === "covered"
    ? "Spot on. That's exactly it."
    : g.status === "wrong"
      ? `Not quite: ${short(g.correction || claim.text)}`
      : `Almost. The key line: ${short(claim.text)}`;
  return { status: g.status, feedback };
}

/** The five most important lines across the session, readable in 30 seconds. */
export async function lastLook(userId: string, planTopics: { topicId: string; claimIds: string[] }[]): Promise<string[]> {
  const items: { topic: string; text: string; mastery: Mastery; id: string }[] = [];
  for (const pt of planTopics) {
    if (!pt.claimIds.length) continue;
    const rows = await all<{ id: string; text: string; topic: string; mastery: string | null }>(
      `SELECT c.id, c.text, t.name AS topic, cc.mastery FROM claims c JOIN topics t ON t.id=c.topic_id
       LEFT JOIN claim_cards cc ON cc.claim_id=c.id AND cc.user_id=?
       WHERE c.topic_id=? AND c.id IN (${pt.claimIds.map(() => "?").join(",")})`,
      userId, pt.topicId, ...pt.claimIds,
    );
    const order = new Map(pt.claimIds.map((id, i) => [id, i]));
    rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    for (const r of rows) items.push({ id: r.id, topic: r.topic, text: r.text, mastery: (r.mastery as Mastery) ?? "red" });
  }
  if (!items.length) return [];
  const trim = (s: string) => (s.length > 130 ? s.slice(0, 127).replace(/\s+\S*$/, "") + "…" : s);
  // fallback: still-red first, round-robin across topics
  const byTopic = new Map<string, typeof items>();
  for (const it of [...items].sort((a, b) => (a.mastery === "red" ? 0 : 1) - (b.mastery === "red" ? 0 : 1))) {
    byTopic.set(it.topic, [...(byTopic.get(it.topic) ?? []), it]);
  }
  const fallback: string[] = [];
  while (fallback.length < 5 && [...byTopic.values()].some((l) => l.length)) {
    for (const [topic, list] of byTopic) {
      const it = list.shift();
      if (it && fallback.length < 5) fallback.push(`${topic}: ${trim(it.text)}`);
    }
  }
  if (!hasAI()) return fallback;
  try {
    const r = await aiJSON(
      {
        model: "fast", maxTokens: 500,
        system: "Compress these exam notes into exactly five lines a student can read in 30 seconds the minute before an exam. Each line: 'Topic: fact', max 18 words, only facts present in the notes, most important first.",
        user: JSON.stringify({ notes: items.map((i) => ({ topic: i.topic, line: i.text, stillWeak: i.mastery === "red" })), output: { lines: ["string"] } }),
      },
      z.object({ lines: z.array(z.string().min(3)).min(3).max(6) }),
    );
    return r.lines.slice(0, 5);
  } catch {
    return fallback;
  }
}
