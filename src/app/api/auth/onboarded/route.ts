// POST /api/auth/onboarded {language?} → marks onboarding complete and stores the chosen language.
import { z } from "zod";
import { run, logEvent } from "@/lib/db";
import { handler, requireUser } from "@/lib/auth";

const Body = z.object({ language: z.enum(["English", "Hinglish", "Hindi"]).optional() });

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "Unknown language" }, { status: 400 });
  await run("UPDATE users SET onboarded=1, language=COALESCE(?, language) WHERE id=?", parsed.data.language ?? null, user.id);
  await logEvent(user.id, "onboarded", { language: parsed.data.language ?? user.language });
  return Response.json({ ok: true });
});
