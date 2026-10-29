import { handler, requireUser, canAccessSubject } from "@/lib/auth";
import { enforceAiLimit } from "@/lib/ratelimit";
import { hasAI } from "@/lib/ai";
import { logEvent } from "@/lib/db";
import { traceRootCause, topicSubjectId } from "@/lib/graph";

export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  const topicId = new URL(req.url).searchParams.get("topicId");
  if (!topicId) return Response.json({ error: "topicId is required" }, { status: 400 });
  const subjectId = await topicSubjectId(topicId);
  if (!subjectId) return Response.json({ error: "Topic not found" }, { status: 404 });
  if (!await canAccessSubject(user.id, subjectId)) return Response.json({ error: "No access" }, { status: 403 });
  if (hasAI()) await enforceAiLimit(user);
  const result = await traceRootCause(user.id, topicId);
  await logEvent(user.id, "root_cause_trace", { topicId, rootId: result.root?.id ?? null, hops: result.path.length - 1 });
  return Response.json({ subjectId, ...result });
});
