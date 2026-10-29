import { handler, requireUser } from "@/lib/auth";
import { isPersona, setDifficulty, setPersona } from "@/lib/viva";
import { assertOwner, body } from "../../_shared";

/** {persona} switches examiner persona; {difficulty:"harder"|"easier"} shifts question level. */
export const POST = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await params;
  await assertOwner(id, user.id);
  const b = await body(req);
  if (b.difficulty === "harder" || b.difficulty === "easier") return Response.json(await setDifficulty(id, b.difficulty));
  if (!isPersona(b.persona)) return Response.json({ error: "Persona must be friendly, strict or fast." }, { status: 400 });
  return Response.json(await setPersona(id, b.persona));
});
