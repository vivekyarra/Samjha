import { z } from "zod";
import { handler, requireUser } from "@/lib/auth";
import { getSettings, saveSettings } from "@/lib/settings";
import { logEvent, run } from "@/lib/db";

/** Settings (+ PUT also accepts { name } to rename the account). */
export const GET = handler(async () => {
  const user = await requireUser();
  return Response.json(await getSettings(user.id));
});

export const PUT = handler(async (req: Request) => {
  const user = await requireUser();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Expected a JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ error: "Expected a settings object" }, { status: 400 });
  }
  const { name, ...patch } = body as Record<string, unknown>;
  if (name !== undefined) {
    const clean = typeof name === "string" ? name.trim().slice(0, 80) : "";
    if (!clean) return Response.json({ error: "Name can't be empty" }, { status: 400 });
    await run("UPDATE users SET name=? WHERE id=?", clean, user.id);
  }
  try {
    const settings = await saveSettings(user.id, patch);
    await logEvent(user.id, "settings_saved", { keys: Object.keys(body as object) });
    return Response.json(settings);
  } catch (e) {
    if (e instanceof z.ZodError) {
      const first = e.issues[0];
      return Response.json({ error: `${first.path.join(".")}: ${first.message}` }, { status: 400 });
    }
    throw e;
  }
});
