// POST /api/ext/grade — same flow as /api/grade (attempt + claim_results + recordGrades), callable with the extension token.
import { z } from "zod";
import { all, get, run, tx, newId, now, logEvent } from "@/lib/db";
import { canAccessSubject } from "@/lib/auth";
import { enforceAiLimit } from "@/lib/ratelimit";
import { gradeExplanation } from "@/lib/grading";
import { recordGrades, getClaimMastery } from "@/lib/mastery";
import type { AttemptKind, GradeResult, Mastery, Topic } from "@/lib/types";
import { badRequest, extHandler, preflight, requireExtUser } from "../_shared";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const OPTIONS = preflight;

const Body = z.object({
  topicId: z.string().min(1).max(64),
  explanation: z.string().min(1).max(20_000),
  kind: z.enum(["explain", "explain_back", "review"]).default("explain"),
  onlyClaimIds: z.array(z.string()).max(200).optional(),
  parentAttemptId: z.string().max(64).optional(),
  afterBuddy: z.boolean().optional(),
});

export const POST = extHandler(async (req) => {
  const user = await requireExtUser(req);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Send {topicId, explanation}.");
  const b = parsed.data;
  const topic = await get<Topic>("SELECT * FROM topics WHERE id=?", b.topicId);
  if (!topic) return Response.json({ error: "Topic not found." }, { status: 404 });
  if (!await canAccessSubject(user.id, topic.subject_id)) return Response.json({ error: "You don't have access to this topic." }, { status: 403 });
  if (b.parentAttemptId && !await get("SELECT 1 FROM attempts WHERE id=? AND user_id=?", b.parentAttemptId, user.id)) {
    return badRequest("Unknown parent attempt.");
  }
  await enforceAiLimit(user);

  const result: GradeResult = await gradeExplanation({ userId: user.id, topicId: topic.id, explanation: b.explanation, onlyClaimIds: b.onlyClaimIds });
  const kind: AttemptKind = b.kind;
  const afterBuddy = b.afterBuddy ?? kind === "explain_back";
  const attemptId = newId("a_");
  await tx(async () => {
    await run(
      "INSERT INTO attempts (id,user_id,topic_id,kind,transcript,result_json,parent_attempt_id,created_at) VALUES (?,?,?,?,?,?,?,?)",
      attemptId, user.id, topic.id, kind, b.explanation, JSON.stringify(result), b.parentAttemptId ?? null, now(),
    );
    for (const g of result.claims) {
      await run("INSERT INTO claim_results (id,attempt_id,claim_id,status,evidence,correction) VALUES (?,?,?,?,?,?)", newId("cr_"), attemptId, g.claim_id, g.status, g.evidence, g.correction);
    }
  });
  await recordGrades(user.id, attemptId, kind, result.claims, { afterBuddy });
  const ids = result.claims.map((c) => c.claim_id);
  const mastery = (await getClaimMastery(user.id, ids)) as Record<string, Mastery>;
  const claims = await all<{ id: string; text: string; page: number | null; source_id: string | null }>(
    "SELECT id, text, page, source_id FROM claims WHERE topic_id=? ORDER BY position",
    topic.id,
  );
  await logEvent(user.id, "ext_grade", { topicId: topic.id, kind, attemptId });
  return Response.json({ attemptId, result, mastery, topicName: topic.name, claims });
});
