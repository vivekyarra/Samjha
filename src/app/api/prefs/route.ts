import { z } from "zod";
import { handler, requireUser, canAccessSubject } from "@/lib/auth";
import { getPrefs, setPref, removePref, resetPrefs, listPrefs, isPrefKey, confirmationFor } from "@/lib/prefs";
import { PREF_DEFAULTS } from "@/lib/types";

async function checkSubject(userId: string, subjectId: string | null | undefined) {
  if (subjectId && !await canAccessSubject(userId, subjectId)) {
    throw new Response(JSON.stringify({ error: "You don't have access to this subject." }), { status: 403, headers: { "content-type": "application/json" } });
  }
}

/** GET /api/prefs?subjectId= → { prefs: rows, effective, defaults } */
export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  const subjectId = new URL(req.url).searchParams.get("subjectId");
  await checkSubject(user.id, subjectId);
  return Response.json({ prefs: await listPrefs(user.id), effective: await getPrefs(user.id, subjectId), defaults: PREF_DEFAULTS });
});

const SetBody = z.object({ key: z.string(), value: z.string().min(1).max(60), subjectId: z.string().nullish() });

/** POST /api/prefs {key, value, subjectId?} */
export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const b = SetBody.safeParse(await req.json().catch(() => ({})));
  if (!b.success || !isPrefKey(b.data.key)) return Response.json({ error: "Unknown preference." }, { status: 400 });
  await checkSubject(user.id, b.data.subjectId);
  await setPref(user.id, b.data.key, b.data.value, b.data.subjectId);
  const confirmation = confirmationFor([{ key: b.data.key, value: b.data.value, persist: b.data.subjectId ? "subject" : "global" }]);
  return Response.json({ ok: true, confirmation, prefs: await listPrefs(user.id) });
});

const DelBody = z.object({ key: z.string().optional(), subjectId: z.string().nullish(), all: z.boolean().optional() });

/** DELETE /api/prefs {key, subjectId?} or {all:true} (also accepts the same as query params) */
export const DELETE = handler(async (req: Request) => {
  const user = await requireUser();
  const q = new URL(req.url).searchParams;
  const raw = await req.json().catch(() => ({}));
  const b = DelBody.safeParse({ key: q.get("key") ?? undefined, subjectId: q.get("subjectId"), all: q.get("all") === "1" || undefined, ...raw });
  if (!b.success) return Response.json({ error: "Bad request." }, { status: 400 });
  if (b.data.all) {
    await resetPrefs(user.id);
    return Response.json({ ok: true, confirmation: "Done, your style is back to the defaults.", prefs: [] });
  }
  if (!isPrefKey(b.data.key)) return Response.json({ error: "Unknown preference." }, { status: 400 });
  await checkSubject(user.id, b.data.subjectId);
  await removePref(user.id, b.data.key, b.data.subjectId);
  const confirmation = confirmationFor([{ key: b.data.key, value: "", persist: "global", remove: true }]);
  return Response.json({ ok: true, confirmation, prefs: await listPrefs(user.id) });
});
