import { handler, requireUser } from "@/lib/auth";
import { enforceAiLimit } from "@/lib/ratelimit";
import { hasAI } from "@/lib/ai";
import { classifyIntent, classifyLocal } from "@/lib/intent";

const MODES = new Set(["explain", "buddy", "browse", "viva", "exam_eve", "onboarding", "review"]);

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const body = (await req.json().catch(() => ({}))) as { text?: unknown; mode?: unknown; hasTopic?: unknown };
  const text = typeof body.text === "string" ? body.text.slice(0, 4000) : "";
  if (!text.trim()) return Response.json({ error: "text is required" }, { status: 400 });
  const mode = typeof body.mode === "string" && MODES.has(body.mode) ? body.mode : "browse";
  const ctx = { mode, hasTopic: body.hasTopic === true };
  if (!classifyLocal(text, ctx) && hasAI()) await enforceAiLimit(user, "intent");
  return Response.json(await classifyIntent(text, ctx));
});
