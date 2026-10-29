import { handler, requireUser } from "@/lib/auth";
import { enforceAiLimit } from "@/lib/ratelimit";
import { endSession, getView } from "@/lib/viva";
import { assertOwner } from "../../_shared";

export const POST = handler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await params;
  await assertOwner(id, user.id);
  await enforceAiLimit(user, "viva");
  const scorecard = await endSession(id);
  return Response.json({ scorecard, view: await getView(id) });
});
