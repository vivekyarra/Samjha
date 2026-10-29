import { z } from "zod";
import { handler, requireUser, canAccessSubject } from "@/lib/auth";
import { enforceAiLimit } from "@/lib/ratelimit";
import { logEvent } from "@/lib/db";
import { topicSubjectId } from "@/lib/graph";
import { lastLook } from "@/lib/exameve";

const Body = z.object({
  topics: z.array(z.object({ topicId: z.string().min(1), claimIds: z.array(z.string()).max(50) })).max(40),
  budgetMin: z.number().optional(),
  elapsedSec: z.number().optional(),
});

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "topics are required" }, { status: 400 });
  const topics: typeof parsed.data.topics = [];
  for (const t of parsed.data.topics) {
    const s = await topicSubjectId(t.topicId);
    if (s && (await canAccessSubject(user.id, s))) topics.push(t);
  }
  await enforceAiLimit(user);
  const lines = await lastLook(user.id, topics);
  await logEvent(user.id, "exam_eve_done", { topics: topics.length, budgetMin: parsed.data.budgetMin, elapsedSec: parsed.data.elapsedSec });
  return Response.json({ lines });
});
