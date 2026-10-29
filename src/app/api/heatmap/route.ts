import { handler, requireUser, canAccessSubject } from "@/lib/auth";
import { allHeatmaps, subjectHeatmap } from "@/lib/mastery";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  const subjectId = new URL(req.url).searchParams.get("subjectId");
  if (!subjectId) return Response.json({ subjects: await allHeatmaps(user.id) });
  if (!await canAccessSubject(user.id, subjectId)) return Response.json({ error: "No access to this subject" }, { status: 403 });
  const map = await subjectHeatmap(user.id, subjectId);
  if (!map) return Response.json({ error: "Subject not found" }, { status: 404 });
  return Response.json(map);
});
