// "This is right" appeal (spec §15): re-grades one claim of an attempt with the student's note as context and
// updates that attempt in place (its claim_results row + result_json), so history and class counts stay single.
import { z } from "zod";
import { handler, requireUser, canAccessSubject } from "@/lib/auth";
import { enforceAiLimit } from "@/lib/ratelimit";
import { get, run, tx, newId, logEvent } from "@/lib/db";
import { gradeWithMeta } from "@/lib/grading";
import { recordGrades, getClaimMastery } from "@/lib/mastery";
import type { AttemptKind, ClaimGrade, GradeResult } from "@/lib/types";

const Body = z.object({
  attemptId: z.string().min(1),
  claimId: z.string().min(1),
  note: z.string().max(1000).optional().default(""),
});

type Stored = GradeResult & { meta?: { afterBuddy?: boolean; appeals?: unknown[] } & Record<string, unknown> };
const bad = (error: string, status = 400) => Response.json({ error }, { status });

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return bad("I couldn't read that appeal. Please try again.");
  const { attemptId, claimId, note } = parsed.data;

  const attempt = await get<{ id: string; topic_id: string | null; kind: string; transcript: string; result_json: string | null }>(
    "SELECT id, topic_id, kind, transcript, result_json FROM attempts WHERE id=? AND user_id=?",
    attemptId,
    user.id,
  );
  if (!attempt || !attempt.topic_id) return bad("I couldn't find that attempt.", 404);
  const topic = await get<{ subject_id: string }>("SELECT subject_id FROM topics WHERE id=?", attempt.topic_id);
  if (!topic || !await canAccessSubject(user.id, topic.subject_id)) return bad("You don't have access to this topic.", 403);
  if (!await get("SELECT 1 FROM claims WHERE id=? AND topic_id=?", claimId, attempt.topic_id)) return bad("That claim isn't part of this topic.", 404);

  let stored: Stored;
  try {
    stored = JSON.parse(attempt.result_json || "null") ?? { claims: [], misconceptions: [], strengths: [] };
  } catch {
    stored = { claims: [], misconceptions: [], strengths: [] };
  }
  const previous = stored.claims.find((c) => c.claim_id === claimId);

  await enforceAiLimit(user);
  const { result: regraded, meta } = await gradeWithMeta({
    userId: user.id,
    topicId: attempt.topic_id,
    explanation: attempt.transcript,
    onlyClaimIds: [claimId],
    appeal: { claimId, note: note.trim() },
  });
  const grade: ClaimGrade | undefined = regraded.claims.find((c) => c.claim_id === claimId);
  if (!grade) return bad("I couldn't re-check that claim. Please try again.", 500);

  const changed = !previous || previous.status !== grade.status;
  const claims = previous ? stored.claims.map((c) => (c.claim_id === claimId ? grade : c)) : [...stored.claims, grade];
  const appeals = [...(stored.meta?.appeals ?? []), { claimId, note: note.trim(), from: previous?.status ?? null, to: grade.status, engine: meta.engine }];
  const next: Stored = { ...stored, claims, meta: { ...(stored.meta ?? {}), appeals } };
  const result: GradeResult = { claims, misconceptions: stored.misconceptions ?? [], strengths: stored.strengths ?? [], ...(stored.not_in_notes ? { not_in_notes: stored.not_in_notes } : {}) };

  await tx(async () => {
    await run("UPDATE attempts SET result_json=? WHERE id=?", JSON.stringify(next), attemptId);
    const row = await get<{ id: string }>("SELECT id FROM claim_results WHERE attempt_id=? AND claim_id=?", attemptId, claimId);
    if (row) await run("UPDATE claim_results SET status=?, evidence=?, correction=? WHERE id=?", grade.status, grade.evidence, grade.correction, row.id);
    else await run("INSERT INTO claim_results (id,attempt_id,claim_id,status,evidence,correction) VALUES (?,?,?,?,?,?)", newId("cr_"), attemptId, claimId, grade.status, grade.evidence, grade.correction);
    if (changed) await recordGrades(user.id, attemptId, attempt.kind as AttemptKind, [grade], { afterBuddy: !!stored.meta?.afterBuddy });
  });

  const mastery = await getClaimMastery(user.id, claims.map((c) => c.claim_id));
  await logEvent(user.id, "grade_appeal", { attemptId, claimId, from: previous?.status ?? null, to: grade.status, engine: meta.engine });
  return Response.json({ attemptId, result, mastery, claim: grade, changed });
});
