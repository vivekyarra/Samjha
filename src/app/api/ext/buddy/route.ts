// POST /api/ext/buddy {topicId, attemptId, mode, question?} — streams the buddy explanation (text/plain), token-auth capable.
import { z } from "zod";
import { get, run, newId, now } from "@/lib/db";
import { canAccessSubject } from "@/lib/auth";
import { enforceAiLimit } from "@/lib/ratelimit";
import { streamBuddy } from "@/lib/buddy";
import type { Topic } from "@/lib/types";
import { badRequest, extHandler, preflight, requireExtUser } from "../_shared";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const OPTIONS = preflight;

const Body = z.object({
  topicId: z.string().min(1).max(64),
  attemptId: z.string().min(1).max(64),
  mode: z.enum(["gaps", "why", "example", "shorter", "stuck", "question", "restyle", "continue"]).default("gaps"),
  question: z.string().max(2000).optional(),
  differentAnalogy: z.boolean().optional(),
});

export const POST = extHandler(async (req) => {
  const user = await requireExtUser(req);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Send {topicId, attemptId, mode}.");
  const b = parsed.data;
  const topic = await get<Topic>("SELECT * FROM topics WHERE id=?", b.topicId);
  if (!topic) return Response.json({ error: "Topic not found." }, { status: 404 });
  if (!await canAccessSubject(user.id, topic.subject_id)) return Response.json({ error: "You don't have access to this topic." }, { status: 403 });
  if (!await get("SELECT 1 FROM attempts WHERE id=? AND user_id=? AND topic_id=?", b.attemptId, user.id, topic.id)) return badRequest("Unknown attempt.");
  await enforceAiLimit(user);

  if (b.question) await run("INSERT INTO buddy_messages (id,attempt_id,role,text,intent,created_at) VALUES (?,?,?,?,?,?)", newId("bm_"), b.attemptId, "user", b.question, b.mode, now());
  const gen = streamBuddy({ userId: user.id, topicId: topic.id, attemptId: b.attemptId, mode: b.mode, question: b.question, differentAnalogy: b.differentAnalogy });
  const enc = new TextEncoder();
  let full = "";
  const stream = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const { done, value } = await gen.next();
        if (done) {
          if (full.trim()) await run("INSERT INTO buddy_messages (id,attempt_id,role,text,intent,created_at) VALUES (?,?,?,?,?,?)", newId("bm_"), b.attemptId, "buddy", full, b.mode, now());
          ctrl.close();
          return;
        }
        full += value;
        ctrl.enqueue(enc.encode(value));
      } catch (e) {
        console.error("[samjha ext buddy]", e);
        ctrl.enqueue(enc.encode("\n\nSorry, the buddy hit a problem. Try again."));
        ctrl.close();
      }
    },
    async cancel() { await gen.return(undefined); },
  });
  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
});
