import { handler, requireUser, canAccessSubject } from "@/lib/auth";
import { enforceAiLimit } from "@/lib/ratelimit";
import { isPersona, listHistory, startPlacement, startViva } from "@/lib/viva";
import { parsePersona } from "@/lib/viva/types";
import { body, domainError } from "./_shared";

export const GET = handler(async () => {
  const user = await requireUser();
  return Response.json({ history: await listHistory(user.id) });
});

/** Start a viva {mode:"viva", subjectId, durationMin, persona} or placement {mode:"placement", repoUrl?, readme?, description?, persona, durationMin?}. */
export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const b = await body(req);
  const persona = isPersona(b.persona) ? b.persona : (typeof b.persona === "string" && parsePersona(b.persona)) || "friendly";
  const d = Number(b.durationMin);
  const durationMin = (d === 5 || d === 15 ? d : 10) as 5 | 10 | 15;
  const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 60000) : undefined);
  await enforceAiLimit(user, "viva");
  try {
    if (b.mode === "placement") {
      const view = await startPlacement({ userId: user.id, repoUrl: str(b.repoUrl), readme: str(b.readme), description: str(b.description), persona, durationMin });
      return Response.json({ view });
    }
    const subjectId = str(b.subjectId);
    if (!subjectId) return Response.json({ error: "Pick a subject first." }, { status: 400 });
    if (!await canAccessSubject(user.id, subjectId)) return Response.json({ error: "You don't have access to that subject." }, { status: 403 });
    const view = await startViva({ userId: user.id, subjectId, durationMin, persona });
    return Response.json({ view });
  } catch (e) {
    return domainError(e);
  }
});
