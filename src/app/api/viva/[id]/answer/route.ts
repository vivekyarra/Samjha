import { handler, requireUser } from "@/lib/auth";
import { enforceAiLimit } from "@/lib/ratelimit";
import { answer } from "@/lib/viva";
import { assertOwner, body, domainError } from "../../_shared";

export const POST = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await params;
  await assertOwner(id, user.id);
  const b = await body(req);
  const text = typeof b.text === "string" ? b.text.slice(0, 8000) : "";
  await enforceAiLimit(user, "viva");
  try {
    return Response.json(await answer(id, text));
  } catch (e) {
    return domainError(e);
  }
});
