// Intent classification (spec §5.2): rules → context → fast model → heuristic fallback.
import "server-only";
import { z } from "zod";
import { hasAI, aiJSON } from "@/lib/ai";
import type { IntentResult } from "@/lib/types";
import { classifyLocal, heuristicIntent, type IntentCtx } from "./rules";

export { classifyRules, classifyContext, classifyLocal, heuristicIntent, normalize, isQuestionLike } from "./rules";
export type { IntentCtx, IntentMode } from "./rules";

const MIN_CONFIDENCE = 0.55;

const ModelSchema = z.object({
  intent: z.enum(["explanation", "style", "scope", "interrupt", "navigation", "control", "unclear"]),
  args: z.record(z.string(), z.union([z.string(), z.boolean(), z.number(), z.null()])).optional().default({}),
  confidence: z.number().min(0).max(1),
});

const SYSTEM = `You classify one utterance a student dictated into Samjha, a voice study buddy. Intents:
- explanation: the student is explaining a topic in their own words (to be graded). args {}
- style: change HOW the buddy explains. args { key: "language"|"analogy"|"length"|"level"|"format"|"tone", value, persist: "global"|"subject"|"once", remove?: true, reset?: true, subject? }
  values: language English/Hinglish/Hindi; analogy free text (cricket, gaming…); length very short/short/normal/detailed; level "like I'm 12"/beginner/exam-level/interview-level; format conversational/bullet points/step-by-step/formula-first; tone chill friend/strict senior/hype coach.
- scope: change WHAT is explained. args { scope } e.g. "only my gaps", "just the formula", "example question", "full topic".
- interrupt: a question or interruption about the current explanation. args { kind: "why"|"example"|"shorter"|"stuck"|"question", text }
- navigation: go somewhere. args { target: "home"|"topic"|"study_next"|"review"|"exam_eve"|"graph"|"viva"|"settings"|"style"|"next_topic"|"upload", topic? }
- control: audio/flow control. args { action: "stop"|"repeat"|"slower"|"faster"|"pause"|"resume"|"done"|"send"|"next" }
- unclear: you cannot tell (especially style vs explanation).
Students may speak Hinglish. The current screen state matters: in "explain" state long text is an explanation; in "buddy" state questions are interrupts.
Return {"intent": ..., "args": {...}, "confidence": 0..1}.`;

function cleanArgs(a: Record<string, string | boolean | number | null>): IntentResult["args"] {
  const out: IntentResult["args"] = {};
  for (const [k, v] of Object.entries(a)) {
    if (v === null) continue;
    out[k] = typeof v === "number" ? String(v) : v;
  }
  return out;
}

/** Classify a Voice Box submission. Never throws. */
export async function classifyIntent(text: string, ctx: IntentCtx): Promise<IntentResult> {
  const local = classifyLocal(text, ctx);
  if (local) return local;
  if (!hasAI()) return heuristicIntent(text, ctx);
  try {
    const r = await aiJSON(
      {
        system: SYSTEM,
        user: `Screen state: ${ctx.mode ?? "browse"}. Has an open topic: ${ctx.hasTopic ? "yes" : "no"}.\nUtterance: """${text.slice(0, 1500)}"""`,
        model: "fast",
        maxTokens: 200,
        cache: true,
      },
      ModelSchema,
    );
    const args = cleanArgs(r.args);
    if (r.intent === "interrupt" && !args.text) args.text = text.trim();
    if (r.intent !== "unclear" && r.confidence < MIN_CONFIDENCE) return { intent: "unclear", args: { ...args, guess: r.intent }, confidence: r.confidence, source: "model" };
    return { intent: r.intent, args, confidence: r.confidence, source: "model" };
  } catch (e) {
    console.error("[samjha intent] model failed, using heuristics", e);
    return heuristicIntent(text, ctx);
  }
}
