import { handler, requireUser, canAccessSubject } from "@/lib/auth";
import { nextToStudy } from "@/lib/mastery";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  const subjectId = new URL(req.url).searchParams.get("subjectId") || undefined;
  if (subjectId && !await canAccessSubject(user.id, subjectId)) return Response.json({ error: "No access to this subject" }, { status: 403 });
  const next = await nextToStudy(user.id, subjectId);
  if (!next) {
    return Response.json({ topicId: null, name: null, subjectId: null, mastery: null, reason: "Nothing red or amber right now. Everything you've studied is solid." });
  }
  return Response.json(next);
});
