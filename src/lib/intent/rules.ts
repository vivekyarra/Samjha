// Pure, dependency-free intent rules (spec §5.2). Safe to import on the client for zero-latency classification.
import type { Intent, IntentResult } from "@/lib/types";

export type IntentMode = "explain" | "buddy" | "browse" | "viva" | "exam_eve" | "onboarding" | "review";
export interface IntentCtx { mode?: IntentMode | string; hasTopic?: boolean }
type Args = IntentResult["args"];

const res = (intent: Intent, args: Args, confidence: number, source: IntentResult["source"]): IntentResult => ({ intent, args, confidence, source });
const rule = (intent: Intent, args: Args, confidence = 0.95) => res(intent, args, confidence, "rules");

/** Lowercase, strip punctuation and leading/trailing fillers. */
export function normalize(text: string): string {
  let n = text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[-–—_/]/g, " ")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const lead = /^(?:ok|okay|um+|uh+|hmm+|hey|so|and|well|please|yeah|achha|acha|accha|arre|arey|bhai|yaar|samjha(?! nahi)|buddy|listen|actually|alright|right)\s+/;
  const polite = /^(?:can you|could you|would you|will you|can u|pls|please)\s+(?:please\s+)?/;
  for (let k = 0; k < 4; k++) {
    const before = n;
    n = n.replace(lead, "").replace(polite, "");
    if (n === before) break;
  }
  n = n.replace(/\s+(?:please|pls|now|thanks|thank you|yaar|na|bhai|okay|ok)$/, "").trim();
  return n;
}

export const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

const QUESTION_START = /^(?:what|what's|whats|how|why|when|where|which|who|whom|whose|is|are|was|were|does|do|did|can|could|should|would|will|isn't|aren't|doesn't|don't|kya|kaise|kyun|kyu|kab|kahan|kaun|kitna)\b/;
export function isQuestionLike(raw: string): boolean {
  return /\?\s*$/.test(raw.trim()) || QUESTION_START.test(normalize(raw));
}

const ANALOGY_STOP = new Set(["a", "an", "the", "real", "concrete", "worked", "one", "another", "different", "better", "simple", "simpler", "some", "more", "good", "new", "other", "example", "an example", "real life", "real world", "practical"]);

interface StyleHit { key: string; value: string; remove?: boolean; reset?: boolean }

/** Style phrase without persistence words. Returns null when not a style command. */
function parseStyle(n: string): StyleHit | null {
  if (/^(?:reset|clear|forget|delete|remove|wipe)\s+(?:all\s+)?(?:of\s+)?(?:my\s+)?(?:the\s+)?(?:style|styles|preferences|prefs|style preferences)$|^(?:default|normal) style$|^go back to (?:the )?default(?: style)?$/.test(n))
    return { key: "", value: "", reset: true };

  if (/^(?:no|stop using|no more|don'?t use|dont use) (?:analogy|analogies)$/.test(n)) return { key: "analogy", value: "", remove: true };
  let m = n.match(/^(?:stop using|stop with|stop giving|no more|don'?t use|do not use|dont use|quit using|no)\s+(?:the\s+)?([a-z][a-z ]{0,25}?)\s*(analogies|analogy|examples|references|stuff)?$/);
  if (m && (m[2] || !/^no\s(?!more\s)/.test(n)) && !/^(?:talking|speaking|reading|it|that|this|explaining|now)$/.test(m[1])) {
    const v = m[1].trim();
    if (/^(?:analogies|analogy|any)$/.test(v)) return { key: "analogy", value: "", remove: true };
    if (/^(?:hinglish|hindi|english)$/.test(v)) return { key: "language", value: cap(v), remove: true };
    if (/^(?:bullet points|bullets)$/.test(v)) return { key: "format", value: "bullet points", remove: true };
    return { key: "analogy", value: v, remove: true };
  }

  m = n.match(/\b(hinglish|hindi|english)\b/);
  if (m && wordCount(n) <= 8 && /^(?:hinglish|hindi|english)(?: (?:please|mein|me|mai|bolo|samjhao|batao|only|explain karo|mein bolo|mein samjhao|mein batao))*$|\b(?:in|into|mein|me|switch to|speak|talk|reply|answer|use)\s+(?:hinglish|hindi|english)\b/.test(n))
    return { key: "language", value: cap(m[1]) };

  // Analogy world
  m = n.match(/^(?:use|with|give me|using|try|do|make it|explain (?:it |this )?(?:with|using))\s+(?:an?\s+|some\s+)?([a-z][a-z ]{1,25}?)\s+(?:analogy|analogies|examples|example|references|comparisons?)$/)
    || n.match(/^([a-z][a-z ]{1,20}?)\s+(?:analogy|analogies)$/)
    || n.match(/^([a-z][a-z ]{1,20}?)\s+(?:wala|waala|wali|vala)\s+(?:example|analogy)(?:\s+(?:do|dena|de do|batao))?$/)
    || n.match(/^explain (?:it |this )?(?:with|using|through|in terms of)\s+([a-z][a-z ]{1,20})$/)
    || n.match(/^(?:compare it to|relate it to|make it about)\s+([a-z][a-z ]{1,20})$/);
  if (m && !ANALOGY_STOP.has(m[1].trim()) && !/\b(?:formula|step|bullet|simple)\b/.test(m[1])) return { key: "analogy", value: m[1].trim() };

  // Length (bare "shorter" is an interrupt, handled elsewhere)
  if (/^(?:keep (?:it|things|answers) (?:short|shorter|brief)(?: from now on| always)?|always (?:be |keep it )?(?:short|shorter|brief))$/.test(n) && /from now on|always/.test(n)) return { key: "length", value: "short" };
  if (/^(?:very short|super short|one line|in one line|one liner|ultra short|just one line|keep it very short)$/.test(n)) return { key: "length", value: "very short" };
  if (/^(?:more detail|more details|in detail|in more detail|detailed(?: answer| explanation| please)?|longer|make it longer|go deeper|elaborate|explain in detail|more depth|in depth|thoda detail mein|detail mein)$/.test(n)) return { key: "length", value: "detailed" };
  if (/^normal length$/.test(n)) return { key: "length", value: "normal" };

  // Level
  if (/^(?:explain (?:it )?)?like i'?m (?:\d{1,2}|five|ten|twelve|a kid|a child|a baby|in school)$|^eli5$|^like a (?:kid|child|beginner|\d{1,2} year old)$|^(?:simpler|make it simpler|simple words|simple language|in simple terms|in simple words|make it simple|easy language|easier|make it easier|aasaan(?: bhasha| shabdon)?(?: mein| me)?|simple mein|asaan karo|aasaan karo)$/.test(n))
    return { key: "level", value: /\d|five|ten|twelve|kid|child|baby|school|eli5/.test(n) ? "like I'm 12" : "beginner" };
  if (/^(?:beginner(?: level)?|i'?m a beginner|basic level|from the basics)$/.test(n)) return { key: "level", value: "beginner" };
  if (/^(?:(?:give me |make it |an? )?exam level(?: answer| explanation)?|exam style(?: answer)?|exam answer|like an exam answer|for the exam|board exam style)$/.test(n)) return { key: "level", value: "exam-level" };
  if (/^(?:(?:make it )?interview level(?: answer)?|like an interview(?: answer)?|interview style(?: answer)?|for interviews?|more advanced|more technical)$/.test(n)) return { key: "level", value: "interview-level" };

  // Format
  if (/^(?:(?:in |as |use )?bullet(?: point)?s?(?: points)?(?: please)?|in bullets|as a list|as bullet points|point(?:s)? (?:mein|wise)|point wise|pointwise)$/.test(n)) return { key: "format", value: "bullet points" };
  if (/^(?:step by step|(?:explain (?:it )?)?step by step|in steps|one step at a time|steps mein)$/.test(n)) return { key: "format", value: "step-by-step" };
  if (/^(?:formulas? first|formula first|start with the formulas?|math first|equations? first|always formula first)$/.test(n)) return { key: "format", value: "formula-first" };
  if (/^(?:conversational(?:ly)?|like a conversation|casual(?:ly)?|talk normally)$/.test(n)) return { key: "format", value: "conversational" };

  // Tone
  if (/^(?:(?:be (?:a )?)?strict(?: senior| mode| teacher)?|be harsh|tough love|don'?t sugarcoat(?: it)?|be brutal)$/.test(n)) return { key: "tone", value: "strict senior" };
  if (/^(?:hype(?: me(?: up)?| coach| mode)?|motivate me|be (?:more )?energetic|pump me up|hype coach mode)$/.test(n)) return { key: "tone", value: "hype coach" };
  if (/^(?:chill(?: mode| friend)?|be chill|relax(?:ed)?|be nice|be friendly|like a friend|friendly(?: tone)?)$/.test(n)) return { key: "tone", value: "chill friend" };
  return null;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Style command with persistence detection: "just this time…", "for physics, always…". */
function parseStyleWithPersist(n: string): Args | null {
  let persist: "global" | "subject" | "once" = "global";
  let subject: string | undefined;
  let s = n;
  const once = /\b(?:just|only) (?:for )?this (?:time|once|one)\b|\bjust this once\b|\bfor now\b|\bis baar\b|\bthis time only\b|\babhi ke liye\b|\bsirf is baar\b/;
  if (once.test(s)) {
    persist = "once";
    s = s.replace(once, " ").replace(/\s+/g, " ").trim();
  }
  const subj = s.match(/^(?:for|in) ([a-z][a-z ]{1,30}?) (?:always |only |use |explain |keep |make |be |give )(.+)$/);
  if (subj && !/^(?:hinglish|hindi|english|short|detail|simple)/.test(subj[1])) {
    persist = "subject";
    subject = subj[1].trim();
    s = subj[2];
  }
  s = s.replace(/^(?:always|from now on|explain(?: it)?|answer|reply|talk|speak|be)\s+/, "").replace(/\s+(?:from now on|always|please)$/, "").trim();
  const hit = parseStyle(s) ?? parseStyle(n);
  if (!hit) return null;
  if (hit.reset) return { reset: true, persist: "global" };
  return { key: hit.key, value: hit.value, persist, ...(subject ? { subject } : {}), ...(hit.remove ? { remove: true } : {}) };
}

type Rule = { re: RegExp; intent: Intent; args: Args | ((m: RegExpMatchArray, n: string) => Args | null); notInExplain?: boolean };

const CONTROL: Rule[] = [
  { re: /^(?:done|i'?m done|i am done|im done|all done|that'?s it|thats it|that is it|that'?s all|that is all|finished|i'?m finished|i have finished|i'?ve finished|ho gaya|ho gya|hogaya|khatam|bas itna(?: hi)?|that'?s my explanation|end of explanation|over)$/, intent: "control", args: { action: "done" } },
  { re: /^(?:send|send it|send this|submit|submit it|submit this)$/, intent: "control", args: { action: "send" } },
  { re: /^(?:stop|stop it|stop talking|stop speaking|stop reading|stop that|be quiet|quiet|shut up|shush|enough|silence|ruko|ruk jao|ruk|bas|bas karo|bas bas|chup|chup karo|band karo|wait|cancel|mute|stop the audio|stop the voice)$/, intent: "control", args: { action: "stop" } },
  { re: /^(?:pause|pause it|pause that|pause the audio|hold on|hold up|one sec(?:ond)?|one moment|just a sec(?:ond)?|ek (?:minute|second|sec|min)|thoda ruko)$/, intent: "control", args: { action: "pause" } },
  { re: /^(?:resume|continue|unpause|go on|carry on|keep going|play|go ahead|aage bolo|chalo|haan bolo|continue reading|keep reading|yes go on|yes continue)$/, intent: "control", args: { action: "resume" } },
  { re: /^(?:repeat|repeat that|repeat it|repeat this|say (?:that|it) again|come again|again|one more time|once more|what did you say|pardon|sorry what|phir se(?: bolo)?|fir se(?: bolo)?|phirse bolo|dobara(?: bolo)?|ek baar aur(?: bolo)?|ek baar phir se(?: bolo)?|repeat the last (?:part|line|bit|sentence))$/, intent: "control", args: { action: "repeat" } },
  { re: /^(?:(?:speak|talk|go|read)\s+)?(?:slower|more slowly|slowly)(?: voice| please)?$|^slow down$|^slower voice$|^too fast$|^you'?re (?:talking|going|speaking) too fast$|^(?:thoda )?dheere(?: bolo| se| se bolo)?$|^aaram se(?: bolo)?$/, intent: "control", args: { action: "slower" } },
  { re: /^(?:(?:speak|talk|go|read)\s+)?(?:faster|quicker|more quickly)(?: voice| please)?$|^speed up$|^speed it up$|^faster voice$|^too slow$|^you'?re (?:talking|going|speaking) too slow$|^jaldi(?: bolo| jaldi)?$|^(?:thoda )?tez(?: bolo)?$/, intent: "control", args: { action: "faster" } },
  { re: /^(?:next|next one|next question|next please|skip|skip it|skip this|agla|agla wala|agla question|move to the next one)$/, intent: "control", args: { action: "next" } },
  { re: /^(?:(?:ok(?:ay)?|now|alright|right)[, ]+)?(?:let me |i(?:'ll| will) )?(?:explain (?:it |this )?back|explain back|my turn|i'?m ready(?: to explain)?|ready to explain)(?: (?:to you|now|please))?$/, intent: "control", args: { action: "explain_back" } },
];

const NAV: Rule[] = [
  { re: /^(?:why am i (?:still )?stuck|why do i keep getting (?:this|it) wrong|what am i missing underneath|find the root cause|root cause|trace (?:it|this|the root cause))$/, intent: "navigation", args: { target: "graph", trace: true } },
  { re: /^(?:so )?what should i (?:study|do|learn|revise|practice|practise|work on|start with)(?: now| next| today| first)?$|^what(?:'s| is)? next(?: to study)?$|^what now$|^what do i (?:study|do) (?:now|next)$|^(?:ab )?kya padh(?:u|oon|na hai)$|^(?:suggest|pick) (?:a topic|something)(?: for me)?$|^where (?:should|do) i start$/, intent: "navigation", args: { target: "study_next" } },
  { re: /^what(?:'s| is)? due(?: today)?$|^what do i (?:need|have) to (?:review|revise)(?: today)?$|^anything due(?: today)?$|^show (?:me )?(?:my )?(?:reviews?|due(?: topics| cards)?)$|^(?:start |open |go to )?(?:my )?reviews?(?: time| page)?$|^let'?s review$|^due today$|^aaj kya due hai$/, intent: "navigation", args: { target: "review" } },
  { re: /^(?:start |open |go to |begin )?exam ?eve(?: mode)?$|^(?:my )?exam (?:is )?tomorrow$|^i have (?:an|my) exam tomorrow$|^(?:exam kal hai|kal exam hai)$|^(?:start )?(?:a )?crash (?:course|mode|session)$|^cram(?: mode)?$|^last minute (?:revision|prep)$|^panic mode$/, intent: "navigation", args: { target: "exam_eve" } },
  { re: /^(?:show |open |go to )?(?:me )?(?:the |my )?(?:concept |topic |knowledge )?(?:graph|map)(?: view)?$|^show (?:me )?(?:the )?prerequisites$|^how are (?:the )?topics connected$/, intent: "navigation", args: { target: "graph" } },
  { re: /^(?:start |begin |open |go to |do )?(?:a |my |the )?(?:practice )?viva(?: mode| practice| session)?$|^(?:start )?(?:a )?practice interview$|^(?:start )?placement(?: mode| prep| practice| interview)?$|^interview me$|^(?:start|practice) (?:an |a )?interview$/, intent: "navigation", args: { target: "viva" } },
  { re: /^(?:open |go to |show )?(?:me )?(?:my |the )?settings(?: page)?$|^voice settings$|^turn (?:off|on) (?:the )?nudges$|^nudge settings$/, intent: "navigation", args: { target: "settings" } },
  { re: /^(?:show |open |go to )?(?:me )?my (?:style|preferences|prefs)(?: page)?$|^style (?:page|settings|cards)$|^(?:open |go to )?the style page$|^what are my preferences$/, intent: "navigation", args: { target: "style" } },
  { re: /^(?:upload|add) (?:my |new |more )?(?:notes|pdf|a pdf|file|a file)$|^new subject$|^(?:create|add) (?:a )?(?:new )?subject$/, intent: "navigation", args: { target: "upload" } },
  { re: /^(?:go |take me )?(?:back )?home$|^(?:show |open |go to )?(?:me )?(?:my |the )?(?:heatmap|heat map|dashboard|home page|homepage|progress|subjects|all subjects|tiles)$|^main (?:page|screen)$/, intent: "navigation", args: { target: "home" } },
  { re: /^(?:next topic|go to the next topic|move on(?: to the next topic)?|let'?s move on|next chapter|agla topic|aage badho|chalo aage|skip this topic|next subject)$/, intent: "navigation", args: { target: "next_topic" } },
  {
    re: /^(?:open|go to|take me to|show me|show|switch to|jump to|let'?s (?:do|study|revise|learn|go to)|i want to (?:study|learn|revise|do)|study|revise|learn|teach me|start)\s+(?:the\s+)?(?:topic\s+|chapter\s+|subject\s+)?(.{2,60})$/,
    intent: "navigation",
    args: (m) => topicArgs(m[1]),
  },
  { re: /^(.{2,60}?)\s+(?:kholo|open karo|khol do|padhna hai|padhte hain|pe chalo)$/, intent: "navigation", args: (m) => topicArgs(m[1]) },
];

function topicArgs(raw: string): Args | null {
  const t = raw.replace(/\s+(?:topic|chapter|page|please)$/, "").trim();
  if (/^(?:my notes|notes|the notes|this|it|that|this topic|explanation|explaining)$/.test(t)) return { target: "notes" };
  if (!t || /^(?:a|an|the|me|over|again)$/.test(t)) return null;
  return { target: "topic", topic: t };
}

const SCOPE: Rule[] = [
  { re: /^(?:(?:only|just|explain only|explain just|tell me only|focus on)\s+)?(?:the\s+)?(?:part|parts|bit|bits|things?)\s+i got wrong$|^only (?:my )?(?:mistakes|gaps|wrong (?:ones|parts))$|^just (?:my )?(?:mistakes|gaps)$|^(?:only )?what i (?:missed|got wrong)$|^sirf galti(?:yan|yaan)?(?: batao)?$/, intent: "scope", args: { scope: "only my gaps" } },
  { re: /^(?:(?:just|only)\s+(?:give me\s+|tell me\s+|show me\s+)?(?:the\s+)?formulas?|formulas? only|sirf formula(?: do| batao)?)$/, intent: "scope", args: { scope: "just the formula" } },
  { re: /^(?:give me|ask me|i want)\s+(?:an?\s+|one\s+)?(?:example|practice|sample|exam|test)\s+question$|^quiz me$|^test me$|^ask me a question$|^(?:ek )?question (?:pucho|do)$/, intent: "scope", args: { scope: "example question" } },
  { re: /^(?:explain |cover |teach )?(?:me )?(?:the )?(?:full|whole|entire|complete) (?:topic|thing|chapter)$|^explain everything$|^(?:everything|start) from scratch$|^poora (?:topic|samjhao)$/, intent: "scope", args: { scope: "full topic" } },
  { re: /^(?:my )?gaps (?:plus|and|with|\+) (?:one|an) example$/, intent: "scope", args: { scope: "gaps + one example" } },
  { re: /^(?:only|just) (?:the )?(definition|definitions|intuition|key points|summary|main idea|derivation)$/, intent: "scope", args: (m) => ({ scope: `just the ${m[1]}` }) },
];

const INTERRUPT: Rule[] = [
  { re: /^(?:(?:but|so|wait|and|hmm)\s+)*(?:why|why so|why is that|why is it|why is that so|why does (?:that|it) (?:happen|work|matter)|why though|how come|but how|kyun|kyu|kyon|aisa kyun|par kyun|kyun\s+(?:hota hai|aisa))$/, intent: "interrupt", args: (_m, n) => ({ kind: "why", text: n }) },
  { re: /^(?:(?:give me|show me|can i get|i need|i want|tell me)\s+)?(?:an?\s+|one\s+|another\s+)?(?:concrete\s+|real\s+|worked\s+|real life\s+|real world\s+|practical\s+)?example(?:\s+please)?$|^for example$|^ek example(?: do| dena| batao| de do)?$|^example (?:de|do|dena|batao|do na)$|^like what$/, intent: "interrupt", args: (_m, n) => ({ kind: "example", text: n }) },
  { re: /^(?:shorter|make it shorter|even shorter|shorter please|(?:say it |explain it )?(?:in )?(?:fewer|less) words|too long|thoda short|aur short|short (?:mein|me|karo)|chhota karo|chota karo|tl ?dr|summari[sz]e(?: it| that)?|in short|briefly|keep it short|short version|cut it short|more concise|be concise)$/, intent: "interrupt", args: (_m, n) => ({ kind: "shorter", text: n }) },
  { re: /^(?:i\s+)?(?:still\s+)?(?:don'?t|do not|dont|didn'?t|did not)\s+(?:get|understand)(?:\s+(?:it|this|that))?(?:\s+at all)?$|^i'?m (?:still )?(?:confused|lost)$|^still (?:confused|lost|don'?t get it)$|^(?:i'?m )?not getting it$|^(?:that )?makes no sense$|^(?:what|huh)$|^(?:samjha|samjhi|samajh) nahi(?: aaya| aya)?$|^nahi samjh(?:a|i|aa)$|^kuch (?:bhi )?(?:samajh nahi aaya|nahi samjha|samajh nahi aya)$|^(?:this is )?confusing$|^explain (?:it |that )?(?:again|differently)$|^try (?:again|another way|a different analogy)$|^(?:use |try |give me )?(?:another|a different) (?:analogy|way|example)$/, intent: "interrupt", args: (_m, n) => ({ kind: "stuck", text: n }), notInExplain: true },
  { re: /^(?:i\s+)?(?:still\s+)?(?:don'?t|do not|dont)\s+(?:get|understand)\s+(?:the\s+)?(.{2,40})$/, intent: "interrupt", args: (_m, n) => ({ kind: "question", text: n }), notInExplain: true },
];

function runRules(rules: Rule[], n: string, ctx: IntentCtx): IntentResult | null {
  for (const r of rules) {
    if (r.notInExplain && ctx.mode === "explain") continue;
    const m = n.match(r.re);
    if (!m) continue;
    const args = typeof r.args === "function" ? r.args(m, n) : r.args;
    if (!args) continue;
    return rule(r.intent, { ...args });
  }
  return null;
}

/** Fast rules for short command phrases. Returns null when no rule decides. */
export function classifyRules(text: string, ctx: IntentCtx = {}): IntentResult | null {
  const n = normalize(text);
  if (!n) return null;
  const words = wordCount(n);
  const maxWords = ctx.mode === "explain" ? 9 : 12;
  if (words > maxWords) return null;

  const inExplain = ctx.mode === "explain";
  const control = runRules(CONTROL, n, ctx);
  if (control) return control;
  // "wait, why?" etc: strip a leading "wait"/"hold on" before matching the rest
  const stripped = n.replace(/^(?:wait|hold on|ruko|one sec)\s+/, "");

  const scope = runRules(SCOPE, stripped, ctx);
  if (scope) return scope;
  const interrupt = runRules(INTERRUPT, stripped, ctx);
  if (interrupt) return interrupt;
  const style = parseStyleWithPersist(stripped);
  if (style) return rule("style", style, 0.92);

  if (inExplain) {
    // Only unmistakable navigation while the student is mid-explanation.
    const nav = runRules(NAV.filter((r) => r.args && typeof r.args !== "function"), n, ctx);
    if (nav && words <= 6) return nav;
    const open = n.match(/^(?:open|go to|take me to|switch to)\s+(?:the\s+)?(?:topic\s+)?(.{2,60})$/);
    if (open) {
      const a = topicArgs(open[1]);
      if (a) return rule("navigation", a, 0.9);
    }
    return null;
  }
  const nav = runRules(NAV, n, ctx);
  if (nav) return nav;
  return null;
}

/** Context rules (spec §5.2 rule 2). */
export function classifyContext(text: string, ctx: IntentCtx = {}): IntentResult | null {
  const n = normalize(text);
  if (!n) return null;
  const words = wordCount(n);
  const q = isQuestionLike(text);
  switch (ctx.mode) {
    case "explain":
      return res("explanation", {}, 0.9, "context");
    case "viva":
      if (words >= 3) return res("explanation", {}, 0.85, "context");
      break;
    case "review":
    case "exam_eve":
      if (words >= 8 && !q) return res("explanation", {}, 0.85, "context");
      if (q) return res("interrupt", { kind: "question", text: text.trim() }, 0.8, "context");
      break;
    case "buddy":
      if (q) return res("interrupt", { kind: "question", text: text.trim() }, 0.85, "context");
      break;
  }
  if (words >= 25 && ctx.hasTopic && !q) return res("explanation", {}, 0.75, "context");
  return null;
}

/** Rules then context. Null means "ask the model". */
export function classifyLocal(text: string, ctx: IntentCtx = {}): IntentResult | null {
  return classifyRules(text, ctx) ?? classifyContext(text, ctx);
}

/** Heuristic used when there is no AI key (or the model call fails). Never returns null. */
export function heuristicIntent(text: string, ctx: IntentCtx = {}): IntentResult {
  const local = classifyLocal(text, ctx);
  if (local) return local;
  const n = normalize(text);
  const words = wordCount(n);
  const h = (intent: Intent, args: Args, c: number) => res(intent, args, c, "context");
  if (!n) return h("unclear", {}, 0);
  if (isQuestionLike(text)) return h("interrupt", { kind: "question", text: text.trim() }, ctx.hasTopic ? 0.65 : 0.6);
  if (words >= 10 && ctx.hasTopic) return h("explanation", {}, 0.65);
  if (words >= 15) return h("explanation", {}, 0.55);
  if (words <= 5 && (ctx.mode === "browse" || !ctx.mode) && !ctx.hasTopic) return h("navigation", { target: "topic", topic: n }, 0.6);
  return h("unclear", { text: text.trim() }, 0.3);
}

/** Strip a trailing "done" / "that's it" from a longer piece. Returns the remainder, or null if there was none. */
export function stripTrailingDone(text: string): string | null {
  const m = text.match(/^([\s\S]*?[^\s,;:-])(\s*[,;:-]?\s+)(?:and\s+)?(i'?m done|i am done|done|that'?s it|that is it|that'?s all|ho gaya|khatam|end of explanation)[\s.!]*$/i);
  if (!m) return null;
  // bare "done"/"that's it" only counts after a sentence break ("…training is done" is part of the explanation)
  if (/^(?:done|that'?s it|that is it|that'?s all)$/i.test(m[3]) && !/[.!?]$/.test(m[1]) && !/[,;:-]/.test(m[2])) return null;
  return wordCount(m[1]) >= 3 ? m[1].trim() : null;
}

/** Strip a trailing "send" (say_send mode). Returns remainder, or null if text doesn't end with send. */
export function stripTrailingSend(text: string): string | null {
  const m = text.match(/^([\s\S]*?)[\s.,!;:-]*\bsend(?: it)?[\s.!]*$/i);
  return m ? m[1].trim() : null;
}
