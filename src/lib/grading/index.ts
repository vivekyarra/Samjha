// Samjha grading (F2, §8.3). Wraps the pure engine in ./core with DB lookups, note retrieval and the model call.
import "server-only";
import { all, get } from "@/lib/db";
import { hasAI, aiJSON, aiProviderName } from "@/lib/ai";
import { retrieveChunks } from "@/lib/ingest";
import type { Claim, GradeResult, Topic } from "@/lib/types";
import { buildGradingPrompt, builtinGrade, finalizeResult, gradeResponseSchema, type GradeChunkInput, type GradeInput } from "./core";

export { repairQuote, GRADER_VERSION } from "./core";

export interface GradeOpts {
  userId: string;
  topicId: string;
  explanation: string;
  onlyClaimIds?: string[];
  appeal?: { claimId: string; note: string };
}
export interface GradeMeta { engine: string; ms: number }

const MODEL_TIMEOUT_MS = Number(process.env.SAMJHA_GRADE_TIMEOUT_MS) || 15000;
const MAX_NOTE_CHARS = 7000;

async function gatherChunks(topic: Topic, claims: Claim[], explanation: string): Promise<GradeChunkInput[]> {
  const out: GradeChunkInput[] = [];
  const seen = new Set<string>();
  let chars = 0;
  const push = (id: string, c: GradeChunkInput) => {
    if (seen.has(id) || chars + c.text.length > MAX_NOTE_CHARS) return;
    seen.add(id);
    chars += c.text.length;
    out.push(c);
  };
  // The cited page of each claim first: it is the ground truth for that claim.
  for (const cl of claims) {
    if (!cl.source_id || cl.page == null) continue;
    const ch = await get<{ id: string; text: string; page: number; source_id: string; file_name: string }>(
      "SELECT c.id, c.text, c.page, c.source_id, s.file_name FROM chunks c JOIN sources s ON s.id=c.source_id WHERE c.source_id=? AND c.page=? LIMIT 1",
      cl.source_id,
      cl.page,
    );
    if (ch) push(ch.id, { text: ch.text.slice(0, 1500), page: ch.page, sourceId: ch.source_id, fileName: ch.file_name });
  }
  try {
    const queries = [`${topic.name}. ${claims.map((c) => c.text).join(" ")}`, explanation.slice(0, 1500)];
    for (const q of queries)
      for (const r of await retrieveChunks(topic.subject_id, q, 4)) push(r.id, { text: r.text.slice(0, 1500), page: r.page, sourceId: r.source_id, fileName: r.file_name });
  } catch (e) {
    console.warn("[samjha grading] note retrieval unavailable", e instanceof Error ? e.message : e);
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("grading timeout")), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });
}

/** Builds the engine input for a topic from the DB. */
export async function buildGradeInput(opts: Omit<GradeOpts, "userId">): Promise<GradeInput> {
  const topic = await get<Topic>("SELECT * FROM topics WHERE id=?", opts.topicId);
  if (!topic) throw new Error("Topic not found");
  const claims = await all<Claim>("SELECT * FROM claims WHERE topic_id=? ORDER BY position, rowid", opts.topicId);
  const only = opts.onlyClaimIds?.length ? opts.onlyClaimIds.filter((id) => claims.some((c) => c.id === id)) : undefined;
  const graded = only?.length ? claims.filter((c) => only.includes(c.id)) : claims;
  return {
    topic: topic.name,
    claims: claims.map((c) => ({ id: c.id, text: c.text, page: c.page })),
    only,
    chunks: claims.length ? await gatherChunks(topic, graded, opts.explanation) : [],
    explanation: opts.explanation,
    appeal: opts.appeal,
  };
}

/** Grades and reports which engine produced the result. Never throws for model errors: the built-in engine takes over. */
export async function gradeWithMeta(opts: GradeOpts): Promise<{ result: GradeResult; meta: GradeMeta }> {
  const t0 = Date.now();
  const input = await buildGradeInput(opts);
  if (!input.claims.length) return { result: { claims: [], misconceptions: [], strengths: [] }, meta: { engine: "built-in", ms: 0 } };
  if (hasAI()) {
    try {
      const p = buildGradingPrompt(input);
      const raw = await withTimeout(aiJSON({ system: p.system, user: p.user, model: "strong", maxTokens: 2500, cache: true }, gradeResponseSchema), MODEL_TIMEOUT_MS);
      return { result: finalizeResult(raw, input), meta: { engine: aiProviderName(), ms: Date.now() - t0 } };
    } catch (e) {
      console.warn("[samjha grading] model grading unavailable, using built-in engine:", e instanceof Error ? e.message.slice(0, 120) : "error");
    }
  }
  return { result: builtinGrade(input), meta: { engine: "built-in", ms: Date.now() - t0 } };
}

export async function gradeExplanation(opts: GradeOpts): Promise<GradeResult> {
  return (await gradeWithMeta(opts)).result;
}
