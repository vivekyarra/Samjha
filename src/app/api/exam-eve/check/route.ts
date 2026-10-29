import { z } from "zod";
import { handler, requireUser, canAccessSubject } from "@/lib/auth";
import { enforceAiLimit } from "@/lib/ratelimit";
import { topicSubjectId } from "@/lib/graph";
import { checkQuestion, gradeCheck } from "@/lib/exameve";

const Body = z.object({
  topicId: z.string().min(1),
  claimIds: z.array(z.string()).max(50).default([]),
  claimId: z.string().nullish(),
  answer: z.string().trim().max(4000).optional(),
  attemptId: z.string().nullish(),
});

/** Without `answer`: returns one check question. With `answer`: grades it and returns one line of feedback. */
export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "topicId is required" }, { status: 400 });
  const b = parsed.data;
  const subjectId = await topicSubjectId(b.topicId);
  if (!subjectId) return Response.json({ error: "Topic not found" }, { status: 404 });
  if (!await canAccessSubject(user.id, subjectId)) return Response.json({ error: "No access" }, { status: 403 });
  await enforceAiLimit(user);
  if (b.answer) {
    return Response.json(await gradeCheck({ userId: user.id, topicId: b.topicId, claimId: b.claimId ?? b.claimIds[0] ?? null, answer: b.answer, parentAttemptId: b.attemptId }));
  }
  return Response.json(await checkQuestion(b.topicId, b.claimIds));
});
