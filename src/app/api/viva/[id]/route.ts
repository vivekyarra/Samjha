import { handler, requireUser } from "@/lib/auth";
import { getView } from "@/lib/viva";
import { assertOwner } from "../_shared";

export const GET = handler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await params;
  await assertOwner(id, user.id);
  return Response.json({ view: await getView(id) });
});
