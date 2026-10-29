import { handler, requireUser, canAccessSubject } from "@/lib/auth";
import { enforceAiLimit } from "@/lib/ratelimit";
import { hasAI } from "@/lib/ai";
import { classView } from "@/lib/class";

/** Anonymous class heatmap + most misunderstood claims. Members only; aggregates only. */
export const GET = handler(async (_req: Request, { params }: { params: Promise<{ subjectId: string }> }) => {
  const user = await requireUser();
  const { subjectId } = await params;
  if (!await canAccessSubject(user.id, subjectId)) return Response.json({ error: "You're not a member of this subject" }, { status: 403 });
  if (hasAI()) await enforceAiLimit(user, "class");
  const view = await classView(user.id, subjectId);
  if (!view) return Response.json({ error: "Subject not found" }, { status: 404 });
  return Response.json(view, { headers: { "cache-control": "private, no-store" } });
});
