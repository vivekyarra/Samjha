// F10 Viva + Placement examiner. State lives in viva_sessions.state_json; scorecard in viva_sessions.scorecard.
import "server-only";
import { all, get, run, newId, now, logEvent } from "@/lib/db";
import { canAccessSubject } from "@/lib/auth";
import { recordGrades } from "@/lib/mastery";
import type { ClaimGrade } from "@/lib/types";
import type {
  AnswerResult, CurrentQuestionView, Level, Persona, Scorecard, ScorecardItem, VivaAnswer, VivaHistoryItem, VivaMode, VivaQuestion, VivaState, VivaView,
} from "./types";
import { personaLabel } from "./types";
import { buildPlacementBank, buildVivaBank, claimsById, gradePlacementAnswer, gradeVivaAnswer, prepareBetter, VivaError, type Graded } from "./examiner";
import { loadRepo, RepoError } from "./github";
import { closingLine, feedbackLine, maxFollowUps, perQuestionSec, personaSwitchLine, phraseQuestion, probe } from "./personas";
import { keywords, shorten } from "./text";

export { VivaError, RepoError };

interface Row {
  id: string; user_id: string; subject_id: string | null; repo_url: string | null; mode: VivaMode; persona: Persona;
  duration_min: number; state_json: string; scorecard: string | null; created_at: string; ended_at: string | null;
}

const VALID_PERSONAS: Persona[] = ["friendly", "strict", "fast"];
export const isPersona = (p: unknown): p is Persona => typeof p === "string" && (VALID_PERSONAS as string[]).includes(p);

async function load(id: string): Promise<{ row: Row; state: VivaState }> {
  const row = await get<Row>("SELECT * FROM viva_sessions WHERE id=?", id);
  if (!row) throw new VivaError("Viva session not found.");
  return { row, state: JSON.parse(row.state_json) as VivaState };
}

async function save(id: string, state: VivaState) {
  await run("UPDATE viva_sessions SET state_json=? WHERE id=?", JSON.stringify(state), id);
}

/** Owner check for route handlers. Returns null when the session doesn't exist or belongs to someone else. */
export async function sessionOwner(id: string): Promise<string | null> {
  return (await get<{ user_id: string }>("SELECT user_id FROM viva_sessions WHERE id=?", id))?.user_id ?? null;
}

function title(row: Row, state: VivaState): string {
  return row.mode === "placement" ? `Placement · ${state.repo?.label ?? "project"}` : `Viva · ${state.subjectName ?? "subject"}`;
}

function currentView(row: Row, state: VivaState): CurrentQuestionView | null {
  const q = state.current;
  if (!q) return null;
  return { id: q.id, text: phraseQuestion(row.persona, q.text, state.asked.length, !!q.parentId), level: q.level, isFollowUp: !!q.parentId, number: state.asked.filter((a) => !a.parentId).length };
}

function view(row: Row, state: VivaState): VivaView {
  const scorecard = row.scorecard ? (JSON.parse(row.scorecard) as Scorecard) : null;
  return {
    id: row.id,
    mode: row.mode,
    persona: row.persona,
    durationMin: row.duration_min,
    title: title(row, state),
    startedAt: state.startedAt,
    endsAt: state.startedAt + row.duration_min * 60_000,
    perQuestionSec: perQuestionSec(row.persona),
    level: state.level,
    current: row.ended_at ? null : currentView(row, state),
    lastFeedback: state.lastFeedback,
    answered: state.answers.length,
    done: !!row.ended_at,
    scorecard,
  };
}

export async function getView(id: string): Promise<VivaView> {
  const { row, state } = await load(id);
  return view(row, state);
}

/** Pick the next bank question: same level first, unseen topics first, nearest level otherwise. */
function nextFromBank(state: VivaState): VivaQuestion | null {
  if (!state.bank.length) return null;
  const seenTopics = new Set(state.asked.map((q) => q.topicId).filter(Boolean));
  const seenKinds = new Set(state.asked.map((q) => q.kind));
  const rank = (q: VivaQuestion) =>
    Math.abs(q.level - state.level) * 10 + (q.topicId && seenTopics.has(q.topicId) ? 3 : 0) + (seenKinds.has(q.kind) ? 1 : 0);
  let best = state.bank[0];
  for (const q of state.bank) if (rank(q) < rank(best)) best = q;
  state.bank = state.bank.filter((q) => q.id !== best.id);
  return best;
}

function timeLeftMs(row: Row, state: VivaState): number {
  return state.startedAt + row.duration_min * 60_000 - Date.now();
}

async function insert(opts: { userId: string; subjectId: string | null; repoUrl: string | null; mode: VivaMode; persona: Persona; durationMin: number; state: VivaState }): Promise<VivaView> {
  const id = newId("v_");
  await run(
    "INSERT INTO viva_sessions (id,user_id,subject_id,repo_url,mode,persona,duration_min,state_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    id, opts.userId, opts.subjectId, opts.repoUrl, opts.mode, opts.persona, opts.durationMin, JSON.stringify(opts.state), now(),
  );
  await logEvent(opts.userId, `${opts.mode}_start`, { id, persona: opts.persona, durationMin: opts.durationMin });
  return getView(id);
}

function freshState(bank: VivaQuestion[], extra: Partial<VivaState>): VivaState {
  const state: VivaState = { startedAt: Date.now(), level: 1, bank, asked: [], answers: [], current: null, followUps: 0, lastFeedback: "", ...extra };
  const first = nextFromBank(state);
  if (!first) throw new VivaError("I couldn't come up with questions for this. Try another subject or add more detail.");
  state.current = first;
  state.asked.push(first);
  return state;
}

const normDuration = (d: number) => ([5, 10, 15].includes(d) ? d : 10);

export async function startViva(opts: { userId: string; subjectId: string; durationMin: 5 | 10 | 15; persona: Persona }): Promise<VivaView> {
  if (!await canAccessSubject(opts.userId, opts.subjectId)) throw new VivaError("You don't have access to that subject.");
  const subject = await get<{ name: string }>("SELECT name FROM subjects WHERE id=?", opts.subjectId);
  if (!subject) throw new VivaError("Subject not found.");
  const duration = normDuration(opts.durationMin);
  const bank = await buildVivaBank(opts.subjectId, duration);
  const state = freshState(bank, { subjectName: subject.name });
  return insert({ userId: opts.userId, subjectId: opts.subjectId, repoUrl: null, mode: "viva", persona: opts.persona, durationMin: duration, state });
}

export async function startPlacement(opts: { userId: string; repoUrl?: string; readme?: string; description?: string; persona: Persona; durationMin?: number }): Promise<VivaView> {
  const repo = await loadRepo(opts);
  const bank = await buildPlacementBank(repo);
  const state = freshState(bank, { repo });
  return insert({ userId: opts.userId, subjectId: null, repoUrl: repo.url, mode: "placement", persona: opts.persona, durationMin: normDuration(opts.durationMin ?? 10), state });
}

/** Viva answers also feed mastery (attempt kind "viva"). Best effort: never breaks the viva. */
async function recordMastery(userId: string, q: VivaQuestion, answer: string, g: Graded) {
  if (!q.topicId || !g.claimStatuses.length) return;
  try {
    const attemptId = newId("a_");
    await run(
      "INSERT INTO attempts (id,user_id,topic_id,kind,transcript,result_json,created_at) VALUES (?,?,?,?,?,?,?)",
      attemptId, userId, q.topicId, "viva", answer, JSON.stringify({ question: q.text, score: g.score, verdict: g.verdict }), now(),
    );
    const grades: ClaimGrade[] = g.claimStatuses.map((s) => ({ claim_id: s.claimId, status: s.status, evidence: s.evidence, correction: s.correction, page: s.page }));
    for (const s of grades) await run("INSERT INTO claim_results (id,attempt_id,claim_id,status,evidence,correction) VALUES (?,?,?,?,?,?)", newId("cr_"), attemptId, s.claim_id, s.status, s.evidence, s.correction);
    await recordGrades(userId, attemptId, "viva", grades, { afterBuddy: false });
  } catch (e) {
    console.warn("[viva] mastery record failed", e);
  }
}

export async function answer(sessionId: string, text: string): Promise<AnswerResult> {
  const { row, state } = await load(sessionId);
  if (row.ended_at) return { feedbackLine: "This viva is already over.", nextQuestion: null, done: true, view: view(row, state) };
  const q = state.current;
  if (!q) return finish(row, state, "");

  const g = row.mode === "placement" && state.repo
    ? await gradePlacementAnswer(q, state.repo, text, row.persona)
    : await gradeVivaAnswer(q, text, row.persona);
  if (row.mode === "viva") await recordMastery(row.user_id, q, text, g);

  const a: VivaAnswer = { questionId: q.id, text: text.trim(), score: g.score, verdict: g.verdict, strong: g.strong, missing: g.missing, citations: g.citations, feedback: "", at: Date.now() };
  state.answers.push(a);

  const timeUp = timeLeftMs(row, state) < 20_000;
  const canProbe = !timeUp && (g.verdict === "weak" || (g.verdict === "partial" && g.missingKeys.length > 0)) && state.followUps < maxFollowUps(row.persona);
  const variant = state.asked.length;

  // Feedback: don't give the answer away when we're about to probe for it.
  let missingHint: string | undefined;
  if (!canProbe && g.missing.length) {
    missingHint = row.mode === "viva"
      ? shorten(g.missing[0].replace(/^You said .*?, but your notes say: /, ""), 110).replace(/\.$/, "")
      : shorten(g.missing[0], 80).replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase());
  }
  const strongHint = g.strong[0] ? shorten(g.strong[0].replace(/"/g, ""), 50) : undefined;
  const fb = g.feedback ?? feedbackLine(row.persona, g.verdict, strongHint, missingHint, variant);
  a.feedback = fb;
  state.lastFeedback = fb;

  let next: VivaQuestion | null = null;
  if (canProbe) {
    const rootId = q.parentId ?? q.id;
    const root = state.asked.find((x) => x.id === rootId) ?? q;
    let probeText = g.followUp;
    if (!probeText) {
      const topic = root.topicName ?? "this";
      let kw = "";
      if (row.mode === "viva") {
        const missClaims = await claimsById(g.missingKeys.slice(0, 1));
        kw = missClaims.length ? keywords(missClaims[0].text, topic, 1)[0] ?? "" : "";
      } else kw = g.missingKeys[0] ?? "";
      probeText = probe(row.persona, topic, kw, state.followUps, variant);
    }
    next = {
      id: newId("q_"), text: probeText, level: q.level, kind: "followup", topicId: q.topicId, topicName: q.topicName, parentId: rootId,
      claimIds: row.mode === "viva" ? g.missingKeys.filter((k) => q.claimIds.includes(k)).slice(0, 2) : [],
      expected: row.mode === "placement" ? (g.missingKeys.length ? g.missingKeys : q.expected) : undefined,
    };
    if (row.mode === "viva" && !next.claimIds.length) next.claimIds = q.claimIds;
    state.followUps += 1;
  } else if (!timeUp) {
    // Adapt difficulty: strong → harder, weak/skipped → easier, partial → stay.
    if (g.verdict === "strong") state.level = Math.min(3, state.level + 1) as Level;
    else if (g.verdict === "weak" || g.verdict === "skipped") state.level = Math.max(1, state.level - 1) as Level;
    next = nextFromBank(state);
    state.followUps = 0;
  }

  if (!next) return finish(row, state, fb);
  state.current = next;
  state.asked.push(next);
  await save(sessionId, state);
  return { feedbackLine: fb, nextQuestion: currentView(row, state), done: false, view: view(row, state) };
}

async function finish(row: Row, state: VivaState, fb: string): Promise<AnswerResult> {
  state.current = null;
  await save(row.id, state);
  const sc = await endSession(row.id);
  const line = `${fb ? fb + " " : ""}${closingLine(row.persona, sc.overall)}`;
  const fresh = await load(row.id);
  fresh.state.lastFeedback = line;
  await save(row.id, fresh.state);
  return { feedbackLine: line, nextQuestion: null, done: true, view: view(fresh.row, fresh.state) };
}

export async function setPersona(sessionId: string, persona: Persona): Promise<{ view: VivaView; line: string }> {
  const { row, state } = await load(sessionId);
  await run("UPDATE viva_sessions SET persona=? WHERE id=?", persona, sessionId);
  const line = personaSwitchLine(persona);
  state.lastFeedback = line;
  await save(sessionId, state);
  return { view: view({ ...row, persona }, state), line };
}

/** "harder" / "easier" by voice: shifts the level and swaps the pending question if it's a fresh bank question. */
export async function setDifficulty(sessionId: string, dir: "harder" | "easier"): Promise<{ view: VivaView; line: string }> {
  const { row, state } = await load(sessionId);
  state.level = (dir === "harder" ? Math.min(3, state.level + 1) : Math.max(1, state.level - 1)) as Level;
  if (state.current && !state.current.parentId && state.current.level !== state.level && !row.ended_at) {
    const old = state.current;
    const replacement = nextFromBank(state);
    if (replacement) {
      state.bank.push(old);
      state.asked = state.asked.filter((q) => q.id !== old.id);
      state.asked.push(replacement);
      state.current = replacement;
      state.followUps = 0;
    }
  }
  const line = dir === "harder"
    ? (row.persona === "strict" ? "Very well. Harder questions." : "Okay, turning it up.")
    : (row.persona === "strict" ? "Fine. We will step back." : "Sure, let's ease off a bit.");
  state.lastFeedback = line;
  await save(sessionId, state);
  return { view: view(row, state), line };
}

export async function endSession(sessionId: string): Promise<Scorecard> {
  const { row, state } = await load(sessionId);
  if (row.scorecard) return JSON.parse(row.scorecard) as Scorecard;
  const qById = new Map(state.asked.map((q) => [q.id, q]));
  const items: ScorecardItem[] = state.answers.map((a) => {
    const q = qById.get(a.questionId);
    return { question: q ? q.text : "", answer: a.text, verdict: a.verdict, strong: a.strong, missing: a.missing, citations: a.citations, isFollowUp: !!q?.parentId };
  });

  // Overall: per root question take the best of root and its follow-ups (follow-ups weighted 0.85).
  const roots = new Map<string, number>();
  for (const a of state.answers) {
    const q = qById.get(a.questionId);
    const rootId = q?.parentId ?? a.questionId;
    const s = q?.parentId ? a.score * 0.85 : a.score;
    roots.set(rootId, Math.max(roots.get(rootId) ?? 0, s));
  }
  const overall = roots.size ? Math.round(([...roots.values()].reduce((x, y) => x + y, 0) / roots.size) * 100) : 0;

  const rootAnswers = state.answers.filter((a) => !qById.get(a.questionId)?.parentId);
  const strongTopics = [...new Set(rootAnswers.filter((a) => a.verdict === "strong").map((a) => qById.get(a.questionId)?.topicName ?? qById.get(a.questionId)?.kind).filter(Boolean))] as string[];
  const weakTopics = [...new Set(rootAnswers.filter((a) => a.verdict === "weak" || a.verdict === "skipped").map((a) => qById.get(a.questionId)?.topicName ?? qById.get(a.questionId)?.kind).filter(Boolean))] as string[];

  let summary: string;
  if (!state.answers.length) summary = "No answers recorded. Start another viva when you're ready.";
  else if (row.mode === "viva") {
    summary = `${roots.size} question${roots.size === 1 ? "" : "s"} answered with ${personaLabel(row.persona).toLowerCase()}.` +
      (strongTopics.length ? ` Strong on ${strongTopics.slice(0, 3).join(", ")}.` : "") +
      (weakTopics.length ? ` Revisit ${weakTopics.slice(0, 3).join(", ")}.` : "");
  } else {
    const strongKinds = rootAnswers.filter((a) => a.verdict === "strong").map((a) => qById.get(a.questionId)?.kind).filter(Boolean);
    const weakKinds = rootAnswers.filter((a) => a.verdict !== "strong").map((a) => qById.get(a.questionId)?.kind).filter(Boolean);
    summary = `${roots.size} question${roots.size === 1 ? "" : "s"} on ${state.repo?.name ?? "your project"}.` +
      (strongKinds.length ? ` Confident on ${[...new Set(strongKinds)].slice(0, 3).join(", ")}.` : "") +
      (weakKinds.length ? ` Shaky on ${[...new Set(weakKinds)].slice(0, 3).join(", ")}.` : "");
  }

  let prepare: Scorecard["prepare"] = [];
  if (row.mode === "placement" && state.repo) {
    const answeredRoots = rootAnswers.map((a) => {
      const q = qById.get(a.questionId)!;
      return { question: q.text, answer: a.text, score: roots.get(q.id) ?? a.score, expected: q.expected ?? [] };
    });
    // Pad with unasked hard questions so there are always three to prepare.
    const pad = state.bank.filter((q) => q.level >= 2).slice(0, Math.max(0, 3 - answeredRoots.length)).map((q) => ({ question: q.text, answer: "", score: 0, expected: q.expected ?? [] }));
    prepare = await prepareBetter(state.repo, [...answeredRoots, ...pad]);
  } else {
    prepare = rootAnswers
      .filter((a) => a.verdict !== "strong")
      .sort((x, y) => x.score - y.score)
      .slice(0, 3)
      .map((a) => ({ question: qById.get(a.questionId)?.text ?? "", why: a.verdict === "skipped" ? "Skipped." : "Missing key points from your notes.", outline: a.missing.slice(0, 2).join(" ") + (a.citations[0] ? ` (see ${a.citations[0].label})` : "") }));
  }

  const sc: Scorecard = {
    mode: row.mode, persona: row.persona, overall, summary, items, prepare,
    durationSec: Math.round((Date.now() - state.startedAt) / 1000), title: title(row, state),
  };
  state.current = null;
  await run("UPDATE viva_sessions SET scorecard=?, ended_at=?, state_json=? WHERE id=?", JSON.stringify(sc), now(), JSON.stringify(state), sessionId);
  await logEvent(row.user_id, `${row.mode}_end`, { id: sessionId, overall, answers: items.length });
  return sc;
}

export async function listHistory(userId: string, max = 30): Promise<VivaHistoryItem[]> {
  const rows = await all<Row>("SELECT * FROM viva_sessions WHERE user_id=? ORDER BY created_at DESC LIMIT ?", userId, max);
  return rows.map((r) => {
    const state = JSON.parse(r.state_json) as VivaState;
    const sc = r.scorecard ? (JSON.parse(r.scorecard) as Scorecard) : null;
    return { id: r.id, mode: r.mode, persona: r.persona, title: title(r, state), createdAt: r.created_at, endedAt: r.ended_at, overall: sc ? sc.overall : null };
  });
}

/** Subjects the user can run a viva on (with claim counts). */
export async function vivaSubjects(userId: string): Promise<{ id: string; name: string; claims: number }[]> {
  return all<{ id: string; name: string; claims: number }>(
    `SELECT s.id, s.name, (SELECT COUNT(*) FROM claims c JOIN topics t ON t.id=c.topic_id WHERE t.subject_id=s.id) AS claims
     FROM subjects s JOIN subject_members m ON m.subject_id=s.id AND m.user_id=? ORDER BY s.created_at DESC`,
    userId,
  );
}
