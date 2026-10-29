import { z } from "zod";
import { handler, requireUser, canAccessSubject } from "@/lib/auth";
import { enforceAiLimit } from "@/lib/ratelimit";
import { get } from "@/lib/db";
import { streamBuddy, saveStudentMessage } from "@/lib/buddy";
import { noteShorter } from "@/lib/prefs";

const Body = z.object({
  topicId: z.string().min(1),
  attemptId: z.string().default(""),
  mode: z.enum(["gaps", "why", "example", "shorter", "stuck", "question", "restyle", "exam_eve", "continue"]).default("gaps"),
  question: z.string().max(2000).optional(),
  oncePrefs: z.record(z.string(), z.string()).optional(),
  differentAnalogy: z.boolean().optional(),
});

const PREF_KEYS = new Set(["language", "analogy", "length", "level", "format", "tone", "scope"]);

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "Missing topic or mode." }, { status: 400 });
  const b = parsed.data;

  const topic = await get<{ subject_id: string }>("SELECT subject_id FROM topics WHERE id=?", b.topicId);
  if (!topic) return Response.json({ error: "Topic not found." }, { status: 404 });
  if (!await canAccessSubject(user.id, topic.subject_id)) return Response.json({ error: "You don't have access to this subject." }, { status: 403 });
  if (b.attemptId) {
    const a = await get<{ user_id: string }>("SELECT user_id FROM attempts WHERE id=?", b.attemptId);
    if (!a || a.user_id !== user.id) return Response.json({ error: "Attempt not found." }, { status: 404 });
  }
  await enforceAiLimit(user, "buddy");

  const oncePrefs = Object.fromEntries(Object.entries(b.oncePrefs ?? {}).filter(([k]) => PREF_KEYS.has(k)));
  if (b.mode !== "gaps" && b.mode !== "exam_eve") await saveStudentMessage(b.attemptId, b.question ?? "", b.mode);
  const suggestion = b.mode === "shorter" ? await noteShorter(user.id) : undefined;

  const gen = streamBuddy({ userId: user.id, topicId: b.topicId, attemptId: b.attemptId, mode: b.mode, question: b.question, oncePrefs, differentAnalogy: b.differentAnalogy });
  // pull the first piece before responding so load errors (404/403) still become JSON responses
  const first = await gen.next();
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!first.done && first.value) controller.enqueue(enc.encode(first.value));
      if (first.done) controller.close();
    },
    async pull(controller) {
      try {
        const n = await gen.next();
        if (n.done) controller.close();
        else controller.enqueue(enc.encode(n.value));
      } catch {
        controller.enqueue(enc.encode("\n\nSorry, I lost my train of thought. Say \"continue\" and I'll pick it up."));
        controller.close();
      }
    },
    async cancel() {
      await gen.return(undefined);
    },
  });
  const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" };
  if (suggestion) headers["x-samjha-suggestion"] = suggestion;
  return new Response(stream, { headers });
});
