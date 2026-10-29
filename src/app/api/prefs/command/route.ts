import { z } from "zod";
import { handler, requireUser, canAccessSubject } from "@/lib/auth";
import { applyStyleCommand } from "@/lib/prefs";

const Body = z.object({ text: z.string().min(1).max(500), subjectId: z.string().nullish() });

/** POST /api/prefs/command {text, subjectId?} → {applied, confirmation, suggestion?, oncePrefs?, commands, prefs} */
export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const b = Body.safeParse(await req.json().catch(() => ({})));
  if (!b.success) return Response.json({ error: "Say a style change, like \"use cricket analogies\"." }, { status: 400 });
  if (b.data.subjectId && !await canAccessSubject(user.id, b.data.subjectId)) return Response.json({ error: "You don't have access to this subject." }, { status: 403 });
  return Response.json(await applyStyleCommand(user.id, b.data.text, b.data.subjectId));
});
