import { handler, requireUser, canAccessSubject } from "@/lib/auth";
import { getGraphView } from "@/lib/graph";

export const GET = handler(async (_req: Request, { params }: { params: Promise<{ subjectId: string }> }) => {
  const user = await requireUser();
  const { subjectId } = await params;
  if (!await canAccessSubject(user.id, subjectId)) return Response.json({ error: "No access" }, { status: 403 });
  return Response.json(await getGraphView(user.id, subjectId));
});
