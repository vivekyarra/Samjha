// Run: npx tsx src/lib/intent/intent.test.ts
import { classifyLocal, heuristicIntent, stripTrailingDone, stripTrailingSend, type IntentCtx } from "./rules";
import { splitSentences, cleanForSpeech } from "../voice/sentences";

type Expect = { intent: string; [k: string]: string | boolean | undefined };
const browse: IntentCtx = { mode: "browse", hasTopic: false };
const buddy: IntentCtx = { mode: "buddy", hasTopic: true };
const explain: IntentCtx = { mode: "explain", hasTopic: true };

const cases: [string, IntentCtx, Expect][] = [
  // Style (§5.2 + F4)
  ["use a cricket analogy", buddy, { intent: "style", key: "analogy", value: "cricket", persist: "global" }],
  ["Use cricket analogies.", buddy, { intent: "style", key: "analogy", value: "cricket" }],
  ["explain with gaming", buddy, { intent: "style", key: "analogy", value: "gaming" }],
  ["cricket wala example do", buddy, { intent: "style", key: "analogy", value: "cricket" }],
  ["in Hinglish", buddy, { intent: "style", key: "language", value: "Hinglish" }],
  ["explain in Hinglish", buddy, { intent: "style", key: "language", value: "Hinglish" }],
  ["Hinglish", { mode: "onboarding" }, { intent: "style", key: "language", value: "Hinglish" }],
  ["hindi mein samjhao", buddy, { intent: "style", key: "language", value: "Hindi" }],
  ["like I'm 12", buddy, { intent: "style", key: "level", value: "like I'm 12" }],
  ["explain like I'm five", buddy, { intent: "style", key: "level", value: "like I'm 12" }],
  ["exam-level answer", buddy, { intent: "style", key: "level", value: "exam-level" }],
  ["interview level", buddy, { intent: "style", key: "level", value: "interview-level" }],
  ["simpler please", buddy, { intent: "style", key: "level", value: "beginner" }],
  ["bullet points", buddy, { intent: "style", key: "format", value: "bullet points" }],
  ["step by step", buddy, { intent: "style", key: "format", value: "step-by-step" }],
  ["for physics, always formula-first", buddy, { intent: "style", key: "format", value: "formula-first", persist: "subject", subject: "physics" }],
  ["just this time, explain in Hindi", buddy, { intent: "style", key: "language", value: "Hindi", persist: "once" }],
  ["stop using cricket", buddy, { intent: "style", key: "analogy", value: "cricket", remove: true }],
  ["no more cricket analogies", buddy, { intent: "style", key: "analogy", value: "cricket", remove: true }],
  ["reset my style", buddy, { intent: "style", reset: true }],
  ["be strict", buddy, { intent: "style", key: "tone", value: "strict senior" }],
  ["hype me up", buddy, { intent: "style", key: "tone", value: "hype coach" }],
  ["more detail", buddy, { intent: "style", key: "length", value: "detailed" }],
  ["keep it short from now on", buddy, { intent: "style", key: "length", value: "short" }],
  // Scope
  ["only the part I got wrong", buddy, { intent: "scope", scope: "only my gaps" }],
  ["just the formula", buddy, { intent: "scope", scope: "just the formula" }],
  ["give me an example question", buddy, { intent: "scope", scope: "example question" }],
  ["quiz me", buddy, { intent: "scope", scope: "example question" }],
  ["explain the whole topic", buddy, { intent: "scope", scope: "full topic" }],
  // Interrupt
  ["wait, why?", buddy, { intent: "interrupt", kind: "why" }],
  ["but why", buddy, { intent: "interrupt", kind: "why" }],
  ["kyun?", buddy, { intent: "interrupt", kind: "why" }],
  ["give me an example", buddy, { intent: "interrupt", kind: "example" }],
  ["example do", buddy, { intent: "interrupt", kind: "example" }],
  ["shorter", buddy, { intent: "interrupt", kind: "shorter" }],
  ["aur short", buddy, { intent: "interrupt", kind: "shorter" }],
  ["too long", buddy, { intent: "interrupt", kind: "shorter" }],
  ["I still don't get it", buddy, { intent: "interrupt", kind: "stuck" }],
  ["samjha nahi", buddy, { intent: "interrupt", kind: "stuck" }],
  ["samajh nahi aaya", buddy, { intent: "interrupt", kind: "stuck" }],
  ["I'm confused", buddy, { intent: "interrupt", kind: "stuck" }],
  ["I don't get the second part", buddy, { intent: "interrupt", kind: "question" }],
  ["What does the learning rate actually control?", buddy, { intent: "interrupt", kind: "question" }],
  ["is that the same as the slope?", buddy, { intent: "interrupt", kind: "question" }],
  // Navigation
  ["open thermodynamics", browse, { intent: "navigation", target: "topic", topic: "thermodynamics" }],
  ["Open gradient descent.", browse, { intent: "navigation", target: "topic", topic: "gradient descent" }],
  ["go to backpropagation", buddy, { intent: "navigation", target: "topic", topic: "backpropagation" }],
  ["chain rule kholo", browse, { intent: "navigation", target: "topic", topic: "chain rule" }],
  ["next topic", buddy, { intent: "navigation", target: "next_topic" }],
  ["show my heatmap", buddy, { intent: "navigation", target: "home" }],
  ["go home", browse, { intent: "navigation", target: "home" }],
  ["start exam-eve mode", browse, { intent: "navigation", target: "exam_eve" }],
  ["I have an exam tomorrow", browse, { intent: "navigation", target: "exam_eve" }],
  ["what should I study now?", browse, { intent: "navigation", target: "study_next" }],
  ["what's due today?", browse, { intent: "navigation", target: "review" }],
  ["show the graph", buddy, { intent: "navigation", target: "graph" }],
  ["why am I stuck?", buddy, { intent: "navigation", target: "graph" }],
  ["start viva", browse, { intent: "navigation", target: "viva" }],
  ["practice interview", browse, { intent: "navigation", target: "viva" }],
  ["open settings", browse, { intent: "navigation", target: "settings" }],
  ["my style", browse, { intent: "navigation", target: "style" }],
  ["kya padhu", browse, { intent: "navigation", target: "study_next" }],
  // Control
  ["stop", buddy, { intent: "control", action: "stop" }],
  ["Stop.", explain, { intent: "control", action: "stop" }],
  ["ruko", buddy, { intent: "control", action: "stop" }],
  ["repeat that", buddy, { intent: "control", action: "repeat" }],
  ["phir se bolo", buddy, { intent: "control", action: "repeat" }],
  ["say that again please", buddy, { intent: "control", action: "repeat" }],
  ["slower", buddy, { intent: "control", action: "slower" }],
  ["slower voice", browse, { intent: "control", action: "slower" }],
  ["dheere bolo", buddy, { intent: "control", action: "slower" }],
  ["faster", buddy, { intent: "control", action: "faster" }],
  ["speed up", buddy, { intent: "control", action: "faster" }],
  ["pause", buddy, { intent: "control", action: "pause" }],
  ["hold on", buddy, { intent: "control", action: "pause" }],
  ["resume", buddy, { intent: "control", action: "resume" }],
  ["keep going", buddy, { intent: "control", action: "resume" }],
  ["done", explain, { intent: "control", action: "done" }],
  ["I'm done.", explain, { intent: "control", action: "done" }],
  ["that's it", explain, { intent: "control", action: "done" }],
  ["ho gaya", explain, { intent: "control", action: "done" }],
  ["next", { mode: "exam_eve" }, { intent: "control", action: "next" }],
  // Context
  ["Gradient descent moves the weights a small step against the gradient so the loss goes down each iteration", explain, { intent: "explanation" }],
  ["so basically the learning rate", explain, { intent: "explanation" }],
  ["It's like cricket where you adjust your shot after each ball", explain, { intent: "explanation" }],
  ["shorter", explain, { intent: "interrupt", kind: "shorter" }],
  ["The model overfits when it memorises noise in the training data instead of the pattern", { mode: "viva" }, { intent: "explanation" }],
];

const fallbackCases: [string, IntentCtx, Expect][] = [
  ["gradient descent", browse, { intent: "navigation", target: "topic" }],
  ["Backprop sends the error backwards through each layer using the chain rule to get gradients", { mode: "browse", hasTopic: true }, { intent: "explanation" }],
  ["what is a loss function", browse, { intent: "interrupt", kind: "question" }],
  ["hmm okay cool", { mode: "buddy", hasTopic: true }, { intent: "unclear" }],
];

let pass = 0;
let fail = 0;
function check(label: string, got: { intent: string; args: Record<string, unknown> } | null, exp: Expect) {
  const ok = !!got && got.intent === exp.intent && Object.entries(exp).every(([k, v]) => k === "intent" || got.args[k] === v);
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${label}\n  expected ${JSON.stringify(exp)}\n  got      ${JSON.stringify(got)}`);
  }
}

for (const [text, ctx, exp] of cases) check(`[${ctx.mode}] "${text}"`, classifyLocal(text, ctx), exp);
for (const [text, ctx, exp] of fallbackCases) check(`fallback [${ctx.mode}] "${text}"`, heuristicIntent(text, ctx), exp);

// Things that must NOT be treated as commands mid-explanation / in buddy
for (const [text, ctx] of [
  ["the gradient tells you which direction is uphill", explain],
  ["and then you multiply by the learning rate", explain],
  ["I don't know", buddy],
] as [string, IntentCtx][]) {
  const r = classifyLocal(text, ctx);
  const ok = ctx.mode === "explain" ? r?.intent === "explanation" : r?.intent !== "style";
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL negative "${text}" got ${JSON.stringify(r)}`);
  }
}

// Helpers
const eq = (label: string, a: unknown, b: unknown) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else {
    fail++;
    console.log(`FAIL ${label}\n  expected ${JSON.stringify(b)}\n  got      ${JSON.stringify(a)}`);
  }
};
eq("trailing done", stripTrailingDone("and that is how the weights get updated. I'm done."), "and that is how the weights get updated.");
eq("trailing done none", stripTrailingDone("the loss is done computing"), null);
eq("trailing done mid", stripTrailingDone("we stop when training is done"), null);
eq("trailing done comma", stripTrailingDone("the loss goes down over time, done"), "the loss goes down over time");
eq("trailing send", stripTrailingSend("use a cricket analogy send"), "use a cricket analogy");
eq("no send", stripTrailingSend("use a cricket analogy"), null);
eq("sentences basic", splitSentences("Hi there. The value is 3.14 here! Is it? Yes."), ["Hi there.", "The value is 3.14 here!", "Is it?", "Yes."]);
eq("sentences abbr", splitSentences("Use e.g. ReLU vs. sigmoid. See Fig. 2 for details. Dr. Ng said so."), ["Use e.g. ReLU vs. sigmoid.", "See Fig. 2 for details.", "Dr. Ng said so."]);
eq("sentences danda", splitSentences("यह ग्रेडिएंट है। अब आगे बढ़ो। ok"), ["यह ग्रेडिएंट है।", "अब आगे बढ़ो।", "ok"]);
eq("sentences list", splitSentences("Steps:\n1. Compute loss.\n2. Backprop."), ["Steps:", "1. Compute loss.", "2. Backprop."]);
eq("sentences citation", splitSentences("Gradients flow backwards [p.4](/sources/s1?page=4). Nice."), ["Gradients flow backwards [p.4](/sources/s1?page=4).", "Nice."]);
eq("clean citation", cleanForSpeech("Gradients **flow** backwards [p.4](/sources/s1?page=4)."), "Gradients flow backwards.");
eq("clean link", cleanForSpeech("- See [the chain rule](/topics/x) first."), "See the chain rule first.");

console.log(`\n${pass} passed, ${fail} failed (${pass + fail} checks)`);
if (fail) process.exit(1);
