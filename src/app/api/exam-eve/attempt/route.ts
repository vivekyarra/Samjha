import { z } from "zod";
import { handler, requireUser, canAccessSubject } from "@/lib/auth";
import { topicSubjectId } from "@/lib/graph";
import { startTopicAttempt } from "@/lib/exameve";

const Body = z.object({ topicId: z.string().min(1), claimIds: z.array(z.string()).min(1).max(50) });

/** Creates an exam_eve attempt whose claim_results mark the gap claims as missing, for /api/buddy. */
export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "topicId and claimIds are required" }, { status: 400 });
  const subjectId = await topicSubjectId(parsed.data.topicId);
  if (!subjectId) return Response.json({ error: "Topic not found" }, { status: 404 });
  if (!await canAccessSubject(user.id, subjectId)) return Response.json({ error: "No access" }, { status: 403 });
  return Response.json({ attemptId: await startTopicAttempt(user.id, parsed.data.topicId, parsed.data.claimIds) });
});
