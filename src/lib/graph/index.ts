// Concept graph + root-cause tracing (spec F8).
import "server-only";
import { z } from "zod";
import { all, get, run, tx, newId, now } from "@/lib/db";
import { gradeExplanation } from "@/lib/grading";
import { hasAI, aiJSON } from "@/lib/ai";
import { getSubjectGraph } from "@/lib/ingest";
import { getClaimMastery, topicColour, recordGrades } from "@/lib/mastery";
import type { AttemptKind, Claim, ClaimGrade, Mastery, Topic } from "@/lib/types";

export type TopicState = Mastery | "ungraded";

export interface TopicMastery {
  mastery: TopicState;
  greenShare: number;
  claims: { id: string; text: string; mastery: Mastery; graded: boolean; page: number | null; source_id: string | null }[];
}

export interface GraphNode {
  id: string;
  name: string;
  mastery: TopicState;
  inExam: boolean;
  claimCount: number;
  depth: number;
  dependants: number;
}
export interface GraphView {
  subject: { id: string; name: string };
  nodes: GraphNode[];
  edges: { id: string; source: string; target: string }[];
}

export interface TraceResult {
  path: string[];
  root: { id: string; name: string; mastery: Mastery } | null;
  needsDiagnostic: { topicId: string; name: string; question: string }[];
  failed: { id: string; name: string; mastery: TopicState } | null;
  minutes: number | null;
  message: string;
}

type TopicWithClaims = Topic & { claims: Claim[] };
interface LoadedGraph {
  subject: { id: string; name: string };
  topics: TopicWithClaims[];
  prerequisites: { topic_id: string; depends_on_topic_id: string }[];
}

export async function loadGraph(subjectId: string): Promise<LoadedGraph> {
  const g = await getSubjectGraph(subjectId);
  return { subject: { id: g.subject.id, name: g.subject.name }, topics: g.topics, prerequisites: g.prerequisites };
}

/** Normalises whatever getClaimMastery returns (record, Map or row list) to a record. */
export async function claimMasteryMap(userId: string, claimIds: string[]): Promise<Record<string, Mastery>> {
  if (!claimIds.length) return {};
  const raw: unknown = await getClaimMastery(userId, claimIds);
  if (raw instanceof Map) return Object.fromEntries(raw as Map<string, Mastery>);
  if (Array.isArray(raw)) {
    const out: Record<string, Mastery> = {};
    for (const r of raw as Record<string, unknown>[]) {
      const id = (r.claim_id ?? r.claimId ?? r.id) as string | undefined;
      if (id && typeof r.mastery === "string") out[id] = r.mastery as Mastery;
    }
    return out;
  }
  return (raw ?? {}) as Record<string, Mastery>;
}

/** Claims this user has ever been graded on (independent of mastery defaults). */
export async function gradedClaimIds(userId: string, claimIds: string[]): Promise<Set<string>> {
  if (!claimIds.length) return new Set();
  const ph = claimIds.map(() => "?").join(",");
  const rows = await all<{ claim_id: string }>(
    `SELECT claim_id FROM claim_cards WHERE user_id=? AND claim_id IN (${ph})
     UNION SELECT cr.claim_id FROM claim_results cr JOIN attempts a ON a.id=cr.attempt_id
     WHERE a.user_id=? AND a.kind!='exam_eve' AND cr.claim_id IN (${ph})`,
    userId, ...claimIds, userId, ...claimIds,
  );
  return new Set(rows.map((r) => r.claim_id));
}

export async function topicMasteries(userId: string, topics: TopicWithClaims[]): Promise<Record<string, TopicMastery>> {
  const ids = topics.flatMap((t) => t.claims.map((c) => c.id));
  const cm = await claimMasteryMap(userId, ids);
  const graded = await gradedClaimIds(userId, ids);
  const out: Record<string, TopicMastery> = {};
  for (const t of topics) {
    const claims = t.claims.map((c) => ({
      id: c.id, text: c.text, page: c.page, source_id: c.source_id,
      mastery: (cm[c.id] ?? "red") as Mastery, graded: graded.has(c.id),
    }));
    const greenShare = claims.length ? claims.filter((c) => c.mastery === "green").length / claims.length : 0;
    const anyGraded = claims.some((c) => c.graded);
    out[t.id] = { claims, greenShare, mastery: anyGraded ? (topicColour(greenShare) as Mastery) : "ungraded" };
  }
  return out;
}

/** prereq map: topic -> topics it depends on. */
export function prereqMap(prereqs: LoadedGraph["prerequisites"]) {
  const deps = new Map<string, string[]>();
  const rev = new Map<string, string[]>();
  for (const p of prereqs) {
    if (p.topic_id === p.depends_on_topic_id) continue;
    deps.set(p.topic_id, [...(deps.get(p.topic_id) ?? []), p.depends_on_topic_id]);
    rev.set(p.depends_on_topic_id, [...(rev.get(p.depends_on_topic_id) ?? []), p.topic_id]);
  }
  return { deps, rev };
}

/** Count of topics that transitively depend on each topic. */
export function dependantCounts(topicIds: string[], rev: Map<string, string[]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of topicIds) {
    const seen = new Set<string>();
    const stack = [...(rev.get(id) ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n) || n === id) continue;
      seen.add(n);
      stack.push(...(rev.get(n) ?? []));
    }
    out[id] = seen.size;
  }
  return out;
}

function depths(topicIds: string[], deps: Map<string, string[]>): Record<string, number> {
  const memo: Record<string, number> = {};
  const visiting = new Set<string>();
  const d = (id: string): number => {
    if (id in memo) return memo[id];
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const ps = (deps.get(id) ?? []).filter((p) => topicIds.includes(p));
    const v = ps.length ? 1 + Math.max(...ps.map(d)) : 0;
    visiting.delete(id);
    memo[id] = v;
    return v;
  };
  for (const id of topicIds) d(id);
  return memo;
}

export async function getGraphView(userId: string, subjectId: string): Promise<GraphView> {
  const g = await loadGraph(subjectId);
  const ids = g.topics.map((t) => t.id);
  const tm = await topicMasteries(userId, g.topics);
  const { deps, rev } = prereqMap(g.prerequisites);
  const dep = depths(ids, deps);
  const dc = dependantCounts(ids, rev);
  const idSet = new Set(ids);
  return {
    subject: g.subject,
    nodes: g.topics.map((t) => ({
      id: t.id, name: t.name, mastery: tm[t.id].mastery, inExam: !!t.in_exam,
      claimCount: t.claims.length, depth: dep[t.id] ?? 0, dependants: dc[t.id] ?? 0,
    })),
    edges: g.prerequisites
      .filter((p) => idSet.has(p.topic_id) && idSet.has(p.depends_on_topic_id) && p.topic_id !== p.depends_on_topic_id)
      .map((p) => ({ id: `${p.depends_on_topic_id}->${p.topic_id}`, source: p.depends_on_topic_id, target: p.topic_id })),
  };
}

export const fixMinutes = (claimCount: number) => Math.max(2, Math.ceil(claimCount * 0.6));

/** Heuristic: turn a claim into a short question. */
export function claimToQuestion(claim: string, topicName: string): string {
  const s = claim.trim().replace(/\.$/, "");
  const m = s.match(/^(.{3,70}?)\s+(is|are|means|refers to|measures|computes)\s+/i);
  if (m) {
    const verb = m[2].toLowerCase();
    const subj = m[1].replace(/^(the|a|an)\s+/i, "");
    if (verb === "is" || verb === "are") return `In one line, what ${verb} ${subj}?`;
    return `In one line, what does ${subj} ${verb === "means" ? "mean" : verb === "refers to" ? "refer to" : verb.replace(/s$/, "")}?`;
  }
  return `In one line, what is ${topicName} about?`;
}

async function diagnosticQuestions(items: { topicId: string; name: string; claims: string[] }[]) {
  const fallback = items.map((i) => ({
    topicId: i.topicId, name: i.name,
    question: i.claims[0] ? claimToQuestion(i.claims[0], i.name) : `In one line, what is ${i.name} about?`,
  }));
  if (!items.length || !hasAI()) return fallback;
  try {
    const res = await aiJSON(
      {
        model: "fast",
        cache: true,
        maxTokens: 500,
        system: "You write one quick diagnostic question per topic for a student. Each question must be answerable in one spoken sentence and test the core idea, using only the given notes. Plain words, no options.",
        user: JSON.stringify({ topics: items.map((i) => ({ topicId: i.topicId, name: i.name, notes: i.claims.slice(0, 3) })), output: { questions: [{ topicId: "string", question: "string" }] } }),
      },
      z.object({ questions: z.array(z.object({ topicId: z.string(), question: z.string().min(5) })) }),
    );
    return fallback.map((f) => ({ ...f, question: res.questions.find((q) => q.topicId === f.topicId)?.question ?? f.question }));
  } catch {
    return fallback;
  }
}

export async function topicSubjectId(topicId: string): Promise<string | null> {
  return (await get<{ subject_id: string }>("SELECT subject_id FROM topics WHERE id=?", topicId))?.subject_id ?? null;
}

/** BFS backwards over prerequisites (≤3 hops) to find the real gap. */
export async function traceRootCause(userId: string, topicId: string): Promise<TraceResult> {
  const subjectId = await topicSubjectId(topicId);
  const empty: TraceResult = { path: [topicId], root: null, needsDiagnostic: [], failed: null, minutes: null, message: "" };
  if (!subjectId) return { ...empty, message: "I couldn't find that topic." };
  const g = await loadGraph(subjectId);
  const byId = new Map(g.topics.map((t) => [t.id, t]));
  const failedTopic = byId.get(topicId);
  if (!failedTopic) return { ...empty, message: "I couldn't find that topic." };
  const tm = await topicMasteries(userId, g.topics);
  const { deps } = prereqMap(g.prerequisites);

  const parent = new Map<string, string>();
  const depth = new Map<string, number>([[topicId, 0]]);
  const order: string[] = [];
  const queue = [topicId];
  while (queue.length) {
    const cur = queue.shift()!;
    const d = depth.get(cur)!;
    if (d >= 3) continue;
    for (const p of deps.get(cur) ?? []) {
      if (depth.has(p) || !byId.has(p)) continue;
      depth.set(p, d + 1);
      parent.set(p, cur);
      order.push(p);
      queue.push(p);
    }
  }

  const pathTo = (id: string) => {
    const back = [id];
    let c = id;
    while (parent.has(c)) { c = parent.get(c)!; back.push(c); }
    return back.reverse();
  };
  const isRed = (id: string) => tm[id]?.mastery === "red";
  const reds = order.filter(isRed);
  const ungraded = order.filter((id) => tm[id]?.mastery === "ungraded");
  const failed = { id: topicId, name: failedTopic.name, mastery: tm[topicId]?.mastery ?? "ungraded" };

  // prefer the deepest red reached through an unbroken red/ungraded chain; else the nearest red
  const chainOk = (id: string) => pathTo(id).slice(1, -1).every((x) => tm[x]?.mastery !== "green");
  const score = (id: string) => (chainOk(id) ? 10 : 0) + depth.get(id)! - tm[id].greenShare;
  const rootId = reds.length ? [...reds].sort((a, b) => score(b) - score(a))[0] : null;

  if (rootId) {
    const root = byId.get(rootId)!;
    const minutes = fixMinutes(root.claims.length);
    return {
      path: pathTo(rootId),
      root: { id: rootId, name: root.name, mastery: "red" },
      needsDiagnostic: [],
      failed,
      minutes,
      message: `You're stuck on ${failedTopic.name} because ${root.name} is red. Want to fix ${root.name} first? It'll take about ${minutes} minutes.`,
    };
  }
  const needsDiagnostic = await diagnosticQuestions(
    ungraded.map((id) => ({ topicId: id, name: byId.get(id)!.name, claims: byId.get(id)!.claims.map((c) => c.text) })),
  );
  return {
    path: [topicId],
    root: null,
    needsDiagnostic,
    failed,
    minutes: null,
    message: needsDiagnostic.length
      ? `Before I can say why ${failedTopic.name} is hard, one quick question about ${needsDiagnostic[0].name}.`
      : order.length
        ? `The topics ${failedTopic.name} builds on look fine. Let's go through ${failedTopic.name} once more, slowly.`
        : `${failedTopic.name} has no prerequisites in your notes, so the gap is in this topic itself.`,
  };
}

/** Stores a graded attempt + claim_results and updates mastery. Returns the attempt id. */
export async function saveGradedAttempt(opts: {
  userId: string; topicId: string; kind: AttemptKind; transcript: string; grades: ClaimGrade[];
  afterBuddy: boolean; parentAttemptId?: string | null; extra?: Record<string, unknown>;
}): Promise<string> {
  const attemptId = newId("a_");
  await tx(async () => {
    await run(
      "INSERT INTO attempts (id,user_id,topic_id,kind,transcript,result_json,parent_attempt_id,created_at) VALUES (?,?,?,?,?,?,?,?)",
      attemptId, opts.userId, opts.topicId, opts.kind, opts.transcript,
      JSON.stringify({ claims: opts.grades, misconceptions: [], strengths: [], ...opts.extra }), opts.parentAttemptId ?? null, now(),
    );
    for (const g of opts.grades) {
      await run("INSERT INTO claim_results (id,attempt_id,claim_id,status,evidence,correction) VALUES (?,?,?,?,?,?)",
        newId("cr_"), attemptId, g.claim_id, g.status, g.evidence, g.correction);
    }
  });
  await recordGrades(opts.userId, attemptId, opts.kind, opts.grades, { afterBuddy: opts.afterBuddy });
  return attemptId;
}

const STOP = new Set("the a an of to in on for and or is are be by with as at it this that from into its their then than so we you".split(" "));
const words = (t: string) => t.toLowerCase().match(/[a-z0-9ऀ-ॿ]+/g)?.filter((w) => w.length > 2 && !STOP.has(w)) ?? [];

/** Grades via the shared grader; on any error falls back to a local word-overlap check. */
export async function safeGrade(opts: { userId: string; topicId: string; explanation: string; claims: { id: string; text: string; page?: number | null }[] }): Promise<ClaimGrade[]> {
  const ids = opts.claims.map((c) => c.id);
  try {
    const res = await gradeExplanation({ userId: opts.userId, topicId: opts.topicId, explanation: opts.explanation, onlyClaimIds: ids });
    const grades = res.claims.filter((g: ClaimGrade) => ids.includes(g.claim_id));
    if (grades.length) return grades;
  } catch {
    // grader unavailable: use the local check below
  }
  const said = new Set(words(opts.explanation));
  return opts.claims.map((c) => {
    const key = [...new Set(words(c.text))];
    const share = key.length ? key.filter((w) => said.has(w)).length / key.length : 0;
    return { claim_id: c.id, status: (share >= 0.4 ? "covered" : "missing") as ClaimGrade["status"], evidence: "", correction: share >= 0.4 ? "" : c.text, page: c.page ?? null };
  });
}

/** Grades a one-line diagnostic answer against the topic's first two claims. */
export async function gradeDiagnostic(userId: string, topicId: string, answer: string) {
  const claims = await all<{ id: string; text: string; page: number | null }>("SELECT id, text, page FROM claims WHERE topic_id=? ORDER BY position, rowid LIMIT 2", topicId);
  if (!claims.length) return { passed: true, feedback: "Nothing to check here yet.", attemptId: null as string | null };
  const grades = await safeGrade({ userId, topicId, explanation: answer, claims });
  const attemptId = await saveGradedAttempt({ userId, topicId, kind: "explain", transcript: answer, grades, afterBuddy: false, extra: { diagnostic: true } });
  const covered = grades.filter((g) => g.status === "covered").length;
  const wrong = grades.find((g) => g.status === "wrong");
  const passed = covered > 0 && !wrong;
  const feedback = passed
    ? "That's right, this one isn't the gap."
    : wrong
      ? `Not quite: ${wrong.correction || claims.find((c) => c.id === wrong.claim_id)?.text}`
      : `This looks like a gap. The key idea: ${claims[0].text}`;
  return { passed, feedback, attemptId };
}
