// GET /api/demo/suggestion?topicId= → { text } deliberately imperfect explanation (1 wrong, 2 missing) for the demo button.
import { get, all } from "@/lib/db";
import { handler, requireUser, canAccessSubject } from "@/lib/auth";
import { suggestionFor } from "@/lib/demo/sample";

export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  const topicId = new URL(req.url).searchParams.get("topicId");
  if (!topicId) return Response.json({ error: "topicId is required" }, { status: 400 });
  const topic = await get<{ id: string; name: string; subject_id: string }>("SELECT id, name, subject_id FROM topics WHERE id=?", topicId);
  if (!topic) return Response.json({ error: "Topic not found" }, { status: 404 });
  if (!await canAccessSubject(user.id, topic.subject_id)) return Response.json({ error: "No access to this topic" }, { status: 403 });
  const claims = await all<{ text: string }>("SELECT text FROM claims WHERE topic_id=? ORDER BY position", topicId);
  return Response.json({ text: suggestionFor(topic.name, claims.map((c) => c.text)) });
});
