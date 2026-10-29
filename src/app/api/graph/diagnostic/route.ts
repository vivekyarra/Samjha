import { z } from "zod";
import { handler, requireUser, canAccessSubject } from "@/lib/auth";
import { enforceAiLimit } from "@/lib/ratelimit";
import { gradeDiagnostic, topicSubjectId } from "@/lib/graph";

const Body = z.object({ topicId: z.string().min(1), answer: z.string().trim().min(1).max(4000) });

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "topicId and answer are required" }, { status: 400 });
  const { topicId, answer } = parsed.data;
  const subjectId = await topicSubjectId(topicId);
  if (!subjectId) return Response.json({ error: "Topic not found" }, { status: 404 });
  if (!await canAccessSubject(user.id, subjectId)) return Response.json({ error: "No access" }, { status: 403 });
  await enforceAiLimit(user);
  return Response.json(await gradeDiagnostic(user.id, topicId, answer));
});
