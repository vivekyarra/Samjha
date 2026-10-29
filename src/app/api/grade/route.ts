import { z } from "zod";
import { handler, requireUser, canAccessSubject } from "@/lib/auth";
import { enforceAiLimit } from "@/lib/ratelimit";
import { get, run, tx, newId, now, logEvent } from "@/lib/db";
import { gradeWithMeta } from "@/lib/grading";
import { recordGrades, getClaimMastery } from "@/lib/mastery";
import type { AttemptKind, Mastery } from "@/lib/types";

const KINDS = ["explain", "explain_back", "review", "viva", "exam_eve"] as const;
const MAX_CHARS = 8000;

const Body = z.object({
  topicId: z.string().min(1),
  explanation: z.string(),
  kind: z.enum(KINDS).default("explain"),
  onlyClaimIds: z.array(z.string()).max(200).optional(),
  parentAttemptId: z.string().nullish(),
  afterBuddy: z.boolean().optional().default(false),
});

const bad = (error: string, status = 400) => Response.json({ error }, { status });

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return bad("I couldn't read that request. Please try again.");
  const b = parsed.data;
  const explanation = b.explanation.trim();
  if (!explanation) return bad("I didn't catch an explanation yet. Say or type it, then send.");
  if (explanation.length > MAX_CHARS) return bad(`That's a long one! Please keep it under ${MAX_CHARS} characters, or explain in two parts.`);

  const topic = await get<{ id: string; subject_id: string }>("SELECT id, subject_id FROM topics WHERE id=?", b.topicId);
  if (!topic) return bad("That topic doesn't exist any more.", 404);
  if (!await canAccessSubject(user.id, topic.subject_id)) return bad("You don't have access to this topic.", 403);

  let parentId: string | null = null;
  if (b.parentAttemptId) {
    const parent = await get<{ id: string }>("SELECT id FROM attempts WHERE id=? AND user_id=?", b.parentAttemptId, user.id);
    parentId = parent?.id ?? null;
  }

  await enforceAiLimit(user);
  const { result, meta } = await gradeWithMeta({ userId: user.id, topicId: b.topicId, explanation, onlyClaimIds: b.onlyClaimIds });

  const attemptId = newId("a_");
  const kind: AttemptKind = b.kind;
  const stored = { ...result, meta: { ...meta, afterBuddy: b.afterBuddy, onlyClaimIds: b.onlyClaimIds ?? null } };
  let mastery: Record<string, Mastery> = {};
  await tx(async () => {
    await run(
      "INSERT INTO attempts (id,user_id,topic_id,kind,transcript,result_json,parent_attempt_id,created_at) VALUES (?,?,?,?,?,?,?,?)",
      attemptId, user.id, b.topicId, kind, explanation, JSON.stringify(stored), parentId, now(),
    );
    for (const g of result.claims)
      await run("INSERT INTO claim_results (id,attempt_id,claim_id,status,evidence,correction) VALUES (?,?,?,?,?,?)", newId("cr_"), attemptId, g.claim_id, g.status, g.evidence, g.correction);
    await recordGrades(user.id, attemptId, kind, result.claims, { afterBuddy: b.afterBuddy });
  });
  mastery = await getClaimMastery(user.id, result.claims.map((c) => c.claim_id));

  const count = (s: string) => result.claims.filter((c) => c.status === s).length;
  await logEvent(user.id, "graded", { attemptId, kind, engine: meta.engine, ms: meta.ms, covered: count("covered"), missing: count("missing"), wrong: count("wrong") });
  return Response.json({ attemptId, result, mastery });
});
