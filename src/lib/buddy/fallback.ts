// Built-in buddy engine (used when no AI provider is available). Pure: takes a prepared context, returns the full explanation text.
import type { Prefs } from "../types";

export type BuddyMode = "gaps" | "why" | "example" | "shorter" | "stuck" | "question" | "restyle" | "exam_eve" | "continue";

export interface NoteBit { sourceId: string; page: number; text: string; fileName?: string; score?: number }
export interface Gap {
  claimId: string;
  text: string;
  status: "wrong" | "missing";
  evidence: string;
  correction: string;
  sourceId: string | null;
  page: number | null;
  notes: NoteBit[];
}
export interface CoveredClaim { claimId: string; text: string; evidence: string }

export interface BuddyCtx {
  mode: BuddyMode;
  topicName: string;
  prefs: Prefs;
  /** Gaps this message must explain (already scoped + sliced), in order. */
  slice: Gap[];
  /** All gaps of the attempt after scope filtering (for counts / "only wrong" notes). */
  gaps: Gap[];
  covered: CoveredClaim[];
  /** Gaps still left after this message. */
  remaining: number;
  /** Gap the student is currently on (why/example/stuck). */
  current?: Gap;
  question?: string;
  questionNotes?: NoteBit[];
  /** Previous buddy text (for "shorter"). */
  prevText?: string;
  /** Earlier buddy texts, used to avoid repeating analogies. */
  history: string[];
  differentAnalogy?: boolean;
  scopeNote?: string;
}

export const WORD_LIMITS: Record<string, number> = { "very short": 40, short: 120, normal: 200, detailed: 350 };
export const wordLimit = (length: string) => WORD_LIMITS[length] ?? 120;
export const gapsPerMessage = (length: string) => ({ "very short": 4, short: 3, normal: 2, detailed: 1 })[length] ?? 3;

export const cite = (sourceId: string | null, page: number | null) => (sourceId && page ? `[p.${page}](/sources/${sourceId}?page=${page})` : "");
export const countWords = (s: string) => s.replace(/\[p\.\d+\]\([^)]*\)/g, "").split(/\s+/).filter(Boolean).length;

const STOP = new Set("a an the of to in on for and or is are was were be been it its this that these those with as by at from into than then so we you they he she i can will would should could not no but if which what when how why do does did has have had their there our your more most less very just also".split(" "));
const stem = (w: string) => w.replace(/(ing|ed|es|s|ly)$/, "");
export const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem));
export function overlap(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (!A.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / A.size;
}
export const sentences = (s: string) => s.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z0-9"(])/).map((x) => x.trim()).filter((x) => x.length > 12);
const lc = (s: string) => (s && /^[A-Z](?:[a-z]|\s)/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const noDot = (s: string) => s.trim().replace(/[.!?]+$/, "");
const clip = (s: string, n: number) => { const w = s.split(/\s+/); return w.length <= n ? s : w.slice(0, n).join(" ") + "…"; };
const isFormula = (s: string) => /[=∝∑∂√≈]|\^|\b[a-z]\s*[-+*/]\s*[a-z]\b|formula|equation/i.test(s);

/** Best sentence from notes for a claim, not a near-copy of it. */
export function bestNote(target: string, notes: NoteBit[], opts: { prefer?: RegExp; avoid?: string } = {}): { s: string; bit: NoteBit } | null {
  let best: { s: string; bit: NoteBit; score: number } | null = null;
  for (const bit of notes) for (const s of sentences(bit.text)) {
    if (s.split(" ").length > 45) continue;
    const sim = overlap(target, s);
    if (opts.avoid && overlap(s, opts.avoid) > 0.8) continue;
    let score = sim + (opts.prefer && opts.prefer.test(s) ? 0.35 : 0);
    if (overlap(s, target) > 0.85 && sim > 0.85) score -= 0.5; // near-duplicate of the claim
    if (sim > 0.25 && (!best || score > best.score)) best = { s, bit, score };
  }
  return best;
}

// ---------- language + tone frames ----------
type Tone = "chill friend" | "strict senior" | "hype coach";
interface Frame {
  opener: (x: string) => string;
  noneRight: string;
  wrong: string;
  youSaid: (e: string) => string;
  missing: string;
  notes: string;
  same: string;
  think: string;
  goOn: (n: number) => string;
  back: string;
  simple: string;
  example: string;
  extra: string;
  why: string;
  stuck: string;
  stuckPrereq: string;
  question: string;
  notInNotes: string;
  backToGaps: string;
  formulaNone: (x: string) => string;
  onlyWrongNone: string;
  allDone: string;
  recap: string;
  fill: string;
  examLine: string;
  interviewLine: string;
}

const EN: Record<Tone, Partial<Frame>> & { base: Frame } = {
  base: {
    opener: (x) => `You got that ${x}, nice.`,
    noneRight: "Good start. Let's sort out a few things.",
    wrong: "Small fix here.",
    youSaid: (e) => `You said "${e}", but actually`,
    missing: "One thing you skipped:",
    notes: "Your notes put it like this:",
    same: "Same idea here:",
    think: "Think of",
    goOn: (n) => `Want me to go on? ${n} more to go.`,
    back: "Now explain it back to me.",
    simple: "In simple words:",
    example: "Here's an example from your notes:",
    extra: "Extra, not in your notes:",
    why: "Here's the why.",
    stuck: "No stress, let's try it from a different angle.",
    stuckPrereq: "If it still feels fuzzy, the gap might be in an earlier topic this one builds on.",
    question: "Good question.",
    notInNotes: "That isn't in your notes, so I won't guess. Add notes on it and ask me again.",
    backToGaps: "Back to your gaps. Want me to go on?",
    formulaNone: (x) => `No formula in your notes for this one. The one-liner: ${x}`,
    onlyWrongNone: "You didn't get anything wrong, just missed a couple of bits.",
    allDone: "That's all your gaps covered.",
    recap: "Quick recap of the whole topic:",
    fill: "Quick question, fill the blank:",
    examLine: "Exam line:",
    interviewLine: "Interview line:",
  },
  "chill friend": {},
  "strict senior": {
    opener: (x) => `Good: you got that ${x}. Now the rest.`,
    noneRight: "Okay, focus. A few things need fixing.",
    wrong: "This is wrong, and it costs marks.",
    missing: "You left this out, and it matters:",
    stuck: "Fine. Different angle, pay attention.",
    question: "Fair question.",
  },
  "hype coach": {
    opener: (x) => `Yes! You nailed that ${x}!`,
    noneRight: "Great energy, let's lock in a few pieces!",
    wrong: "So close, quick fix and you're there!",
    missing: "One more piece and you've got the full set:",
    stuck: "Totally fine, we'll crack it another way!",
    question: "Love that question!",
    back: "You've got this. Now explain it back to me.",
  },
};

const HINGLISH: Record<Tone, Partial<Frame>> & { base: Frame } = {
  base: {
    ...EN.base,
    opener: (x) => `Dekho, ${x} wala part tumne bilkul sahi bola, nice.`,
    noneRight: "Achha start hai. Chalo kuch cheezein theek karte hain.",
    wrong: "Yahan thoda gadbad hai.",
    youSaid: (e) => `Tumne bola "${e}", par actually`,
    missing: "Ek cheez miss ho gayi:",
    notes: "Tumhare notes mein likha hai:",
    same: "Bilkul waise hi yahan:",
    think: "Socho,",
    goOn: (n) => `Aage chalun? ${n} aur baaki hain. Want me to go on?`,
    back: "Chalo, ab tum mujhe samjhao. Now explain it back to me.",
    simple: "Simple bolun toh:",
    example: "Tumhare notes se ek example:",
    extra: "Extra, not in your notes:",
    why: "Kyun? Dekho.",
    stuck: "Koi baat nahi, dusre tarike se samjhata hoon.",
    stuckPrereq: "Agar ab bhi clear nahi hai, toh shayad pichle topic mein gap hai.",
    question: "Achha sawaal hai.",
    notInNotes: "Yeh tumhare notes mein nahi hai, toh main guess nahi karunga.",
    backToGaps: "Wapas tumhare gaps pe. Aage chalun?",
    formulaNone: (x) => `Iska formula notes mein nahi hai. One-liner: ${x}`,
    onlyWrongNone: "Tumne kuch galat nahi bola, bas kuch cheezein miss hui.",
    allDone: "Saare gaps cover ho gaye.",
    recap: "Poore topic ka quick recap:",
    fill: "Jaldi se blank bharo:",
  },
  "chill friend": {},
  "strict senior": {
    opener: (x) => `Theek hai, ${x} sahi tha. Ab baaki suno.`,
    wrong: "Yeh galat hai, exam mein marks katenge.",
    missing: "Yeh tumne chhod diya, aur yeh important hai:",
  },
  "hype coach": {
    opener: (x) => `Arre wah! ${x}, ekdum sahi pakda!`,
    wrong: "Bas ek chhota fix, phir tum champion ho!",
    missing: "Ek piece aur, aur poora set ready!",
  },
};

const HINDI: Record<Tone, Partial<Frame>> & { base: Frame } = {
  base: {
    ...EN.base,
    opener: (x) => `शाबाश, यह बात तुमने सही बताई: ${x}।`,
    noneRight: "अच्छी शुरुआत है। चलो कुछ बातें ठीक करते हैं।",
    wrong: "यहाँ थोड़ी गलती है।",
    youSaid: (e) => `तुमने कहा "${e}", लेकिन असल में`,
    missing: "एक बात छूट गई:",
    notes: "तुम्हारे नोट्स में लिखा है:",
    same: "यहाँ भी वही बात:",
    think: "सोचो,",
    goOn: (n) => `आगे बताऊँ? ${n} और बाकी हैं।`,
    back: "अब मुझे वापस समझाओ। Now explain it back to me.",
    simple: "आसान शब्दों में:",
    example: "तुम्हारे नोट्स से एक उदाहरण:",
    extra: "Extra, not in your notes:",
    why: "क्यों? देखो।",
    stuck: "कोई बात नहीं, दूसरे तरीके से समझाता हूँ।",
    stuckPrereq: "अगर अब भी साफ़ नहीं है, तो शायद पिछले टॉपिक में कमी है।",
    question: "अच्छा सवाल है।",
    notInNotes: "यह तुम्हारे नोट्स में नहीं है, इसलिए मैं अंदाज़ा नहीं लगाऊँगा।",
    backToGaps: "वापस तुम्हारी कमियों पर। आगे बताऊँ?",
    formulaNone: (x) => `इसका फ़ॉर्मूला नोट्स में नहीं है। एक लाइन में: ${x}`,
    onlyWrongNone: "तुमने कुछ गलत नहीं कहा, बस कुछ बातें छूट गईं।",
    allDone: "सारी कमियाँ पूरी हो गईं।",
    recap: "पूरे टॉपिक का छोटा रिकैप:",
    fill: "जल्दी से खाली जगह भरो:",
  },
  "chill friend": {},
  "strict senior": { wrong: "यह गलत है, परीक्षा में नंबर कटेंगे।", missing: "यह तुमने छोड़ दिया, और यह ज़रूरी है:" },
  "hype coach": { opener: (x) => `वाह! ${x}, बिल्कुल सही!`, wrong: "बस एक छोटा सुधार, फिर तुम चैंपियन हो!" },
};

export function frame(prefs: Prefs): Frame {
  const set = prefs.language === "Hinglish" ? HINGLISH : prefs.language === "Hindi" ? HINDI : EN;
  const tone = (["chill friend", "strict senior", "hype coach"].includes(prefs.tone) ? prefs.tone : "chill friend") as Tone;
  return { ...set.base, ...set[tone] } as Frame;
}

// ---------- analogies ----------
type Cat = "memorize" | "chain" | "iterate" | "minimize" | "balance" | "default";
export function category(text: string): Cat {
  const t = text.toLowerCase();
  if (/overfit|memori|generali|unseen|training data|noise|variance|bias/.test(t)) return "memorize";
  if (/trade|balance|too (?:large|small|big|high|low|much|little)|regulari|penalt|versus|\bvs\b/.test(t)) return "balance";
  if (/chain|backward|propagat|layer|depend|flow|sequence|multipl|composit/.test(t)) return "chain";
  if (/minim|lowest|descent|slope|gradient|downhill|optim|reduce|loss|error|cost/.test(t)) return "minimize";
  if (/step|iterat|repeat|update|epoch|until|converg|learning rate|loop/.test(t)) return "iterate";
  return "default";
}

const ANALOGIES: Record<string, Record<Cat, string>> = {
  cricket: {
    iterate: "a batter in the nets: face a ball, see where it went, adjust the stance a little, face the next one.",
    chain: "a run-out: the throw goes fielder to keeper to stumps, and to find who messed up you trace it back along that chain.",
    minimize: "a bowler adjusting line and length after every boundary, always nudging towards the spot that leaks the fewest runs.",
    memorize: "a batter who only practised against one net bowler: perfect in the nets, clueless against a new bowler in the match.",
    balance: "setting a field: too attacking and you leak runs, too defensive and you never take wickets.",
    default: "reading the pitch before you bat: once you get this, the rest of the innings makes sense.",
  },
  gaming: {
    iterate: "grinding a boss fight: try, die, tweak your build a little, try again until you clear it.",
    chain: "a quest chain: each quest unlocks the next, and to find why the final reward bugged out you walk back through the chain.",
    minimize: "finding the lowest valley on a foggy open-world map: you only feel the slope under your feet, so you keep stepping downhill.",
    memorize: "a player who memorised one map's spawn points: unbeatable there, lost on a new map.",
    balance: "balancing a build: all damage and no defence loses, all tank and no damage loses too.",
    default: "learning a game's core mechanic: once it clicks, every level gets easier.",
  },
  movies: {
    iterate: "a director doing take after take, fixing one small thing each time until the scene works.",
    chain: "a thriller's twist: to understand the ending you rewind scene by scene, each one depending on the one before.",
    minimize: "an editor trimming cut after cut, each pass chopping whatever hurts the story most.",
    memorize: "an actor who memorised the script word for word but freezes when a co-star improvises.",
    balance: "a film's runtime: too short feels rushed, too long gets boring.",
    default: "the setup scene of a movie: miss it, and the rest of the plot doesn't make sense.",
  },
  bollywood: {
    iterate: "a dance rehearsal before the big song: run it, fix one step, run it again until it's perfect.",
    chain: "a family drama where one secret from the first act explains everything in the climax.",
    minimize: "a hero training montage, every round a little less sloppy than the last.",
    memorize: "a hero who memorised dialogues but can't handle an unscripted moment.",
    balance: "a masala film: too much drama or too much comedy, and it doesn't work.",
    default: "the interval twist: once you know it, the whole story clicks.",
  },
  cooking: {
    iterate: "seasoning a curry: taste, add a pinch, taste again, keep adjusting until it's right.",
    chain: "a recipe that tastes off: you trace back through each step to find where it went wrong.",
    minimize: "reducing a sauce bit by bit, checking each time, until it's exactly right.",
    memorize: "someone who can only cook one exact recipe: change one ingredient and they're lost.",
    balance: "salt: too little is bland, too much is ruined.",
    default: "knowing why you temper the spices first: once you get the why, the recipe makes sense.",
  },
  football: {
    iterate: "a striker taking penalty after penalty in training, adjusting the run-up a little each time.",
    chain: "replaying a conceded goal backwards, defender to midfielder to the first lost ball.",
    minimize: "a team tightening its defence game by game, each change aimed at conceding fewer goals.",
    memorize: "a team that only drilled against one opponent and collapses against anyone new.",
    balance: "a formation: push everyone forward and you get countered, park the bus and you never score.",
    default: "the offside rule: once you get it, the whole game makes sense.",
  },
  anime: {
    iterate: "a training arc: the hero fails, trains, gets a bit stronger, tries again until the technique works.",
    chain: "a flashback episode walking backwards through events to show how one choice caused everything.",
    minimize: "a sensei's drill where each attempt wastes a little less energy until the move is perfect.",
    memorize: "a character who copied one opponent's moves perfectly but can't handle a new enemy.",
    balance: "a power-up with a cost: too much power breaks the body, too little loses the fight.",
    default: "the rules of a shonen power system: once you get them, every fight makes sense.",
  },
  music: {
    iterate: "tuning a guitar: pluck, listen, twist the peg a little, pluck again.",
    chain: "a song where the bridge only works because of the chords before it.",
    minimize: "a producer adjusting the mix track by track until nothing clashes.",
    memorize: "someone who can play one song by muscle memory but can't jam.",
    balance: "volume levels: vocals too loud or too soft both ruin the track.",
    default: "learning the beat first: once you feel it, the rest of the song falls in place.",
  },
  everyday: {
    iterate: "tuning a radio: turn the knob a little, listen, turn again until it's clear.",
    chain: "a line of dominoes: to see why the last one fell, follow the chain back to the first push.",
    minimize: "walking down a hill in thick fog: you can't see the bottom, so you feel the slope and keep stepping downhill.",
    memorize: "a student who memorised last year's paper: fine if the same questions come, stuck the moment they change.",
    balance: "a thermostat: too high and you sweat, too low and you freeze.",
    default: "learning the rules before playing a game: once you know this, the rest follows.",
  },
};
const WORLD_ORDER = ["everyday", "cricket", "movies", "gaming", "cooking", "football", "anime", "music", "bollywood"];

/** Pick an analogy line not already used in history. */
/** `local` holds analogies already used in this message; they are always skipped and the pick is appended. */
export function pickAnalogy(world: string, text: string, history: string[], forceDifferent: boolean, think: string, local: string[] = []): string {
  const w = world.toLowerCase().trim();
  const cat = category(text);
  const known = ANALOGIES[w];
  const worlds = known ? [w] : world ? ["everyday"] : WORLD_ORDER;
  const used = (s: string) => history.some((h) => h.includes(s.slice(0, 40)));
  const cats: Cat[] = [cat, "default", "iterate", "chain", "minimize", "balance", "memorize"];
  const candidates: string[] = [];
  for (const wd of worlds) for (const c of cats) if (!candidates.includes(ANALOGIES[wd][c])) candidates.push(ANALOGIES[wd][c]);
  const usable = candidates.filter((c) => !local.includes(c) && (!forceDifferent || !used(c)));
  const pick = usable[0] ?? candidates.find((c) => !local.includes(c)) ?? candidates[0];
  local.push(pick);
  const prefix = world && !known ? `Picture it in ${world} terms. ` : "";
  return `${prefix}${think} ${pick}`;
}

// ---------- composition ----------
function blankOut(claim: string): string | null {
  const words = claim.split(" ");
  let bi = -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/[^A-Za-z]/g, "");
    if (w.length > 5 && !STOP.has(w.toLowerCase()) && (bi < 0 || w.length > words[bi].replace(/[^A-Za-z]/g, "").length) && i > 0) bi = i;
  }
  if (bi < 0) return null;
  const out = [...words];
  out[bi] = out[bi].replace(/[A-Za-z][A-Za-z-]*/, "____");
  return out.join(" ");
}

function fitParts(parts: string[], limit: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const [i, p] of parts.entries()) {
    if (!p) continue;
    const n = countWords(p);
    if (i === 0) {
      out.push(n > limit ? clip(p, limit) : p);
      used += Math.min(n, limit);
      continue;
    }
    if (used + n <= limit) {
      out.push(p);
      used += n;
    }
  }
  return out;
}

function render(parts: string[], format: string, idx: number): string {
  if (format === "bullet points") return parts.map((p) => `- ${p}`).join("\n");
  if (format === "step-by-step") return parts.map((p, i) => `${i === 0 ? `**${idx + 1}.** ` : "   "}${i === 0 ? "" : `Step ${i + 1}: `}${p}`).join("\n");
  if (format === "formula-first") {
    const f = parts.findIndex((p, i) => i > 0 && isFormula(p));
    if (f > 0) parts = [parts[f], ...parts.filter((_, i) => i !== f)];
  }
  return parts.join(" ");
}

function exampleFor(g: Gap, c: BuddyCtx, F: Frame): string {
  const hit = bestNote(g.text, g.notes, { prefer: /\b(e\.g\.|for example|for instance|suppose|consider|example|say we|imagine)\b/i });
  if (hit && /\b(e\.g\.|for example|for instance|suppose|consider|example|say we|imagine)\b/i.test(hit.s)) return `${F.example} "${hit.s}" ${cite(hit.bit.sourceId, hit.bit.page)}`.trim();
  const gist = lc(noDot(g.text));
  const t: Record<Cat, string> = {
    iterate: `start with a rough guess, check how wrong it is, adjust a little, and check again. After a few rounds you're close. That loop is the point: ${gist}.`,
    chain: `say A feeds B and B feeds C. If C is off, you ask how much C depends on B and how much B depends on A, and combine them going backwards. That's the idea: ${gist}.`,
    minimize: `say your error starts at 10. One small step in the direction that lowers it fastest: 8, then 6.5, then 5.6, steps shrinking as the slope flattens. That's ${gist}.`,
    memorize: `a model scores 99% on practice questions but 60% on new ones. It learned the questions, not the idea. That's what this is about: ${gist}.`,
    balance: `pick a setting way too big and things blow up; way too small and nothing moves. The right value sits in between. That's why ${gist}.`,
    default: `if an exam question asks about ${c.topicName}, the line that earns the marks is "${noDot(g.text)}". Write it, then add one sentence of why.`,
  };
  return `${F.extra} ${t[category(g.text)]}`;
}

function gapBlock(g: Gap, i: number, c: BuddyCtx, F: Frame, limit: number, forceDifferent: boolean, local: string[] = []): string {
  const { prefs } = c;
  const kid = prefs.level === "like I'm 12" || prefs.level === "beginner";
  const link = cite(g.sourceId, g.page);
  const claim = noDot(g.text);
  if (prefs.scope === "just the formula") {
    const f = [g.text, ...g.notes.flatMap((n) => sentences(n.text))].find(isFormula);
    return f ? `${f} ${link}`.trim() : `${F.formulaNone(claim + ".")} ${link}`.trim();
  }
  if (prefs.scope === "example question") {
    const b = blankOut(g.text);
    return b ? `${F.fill} "${b}" ${link}`.trim() : `Quick question: in one line, why is it true that ${lc(claim)}? ${link}`.trim();
  }
  const core =
    g.status === "wrong"
      ? `${F.wrong} ${g.evidence ? `${F.youSaid(clip(g.evidence, 18))} ${lc(noDot(g.correction || g.text))}.` : `${noDot(g.correction || g.text)}.`} ${link}`
      : `${F.missing} ${kid ? `${F.simple} ` : ""}${claim}. ${link}`;
  const note = bestNote(g.text, g.notes, { avoid: g.text });
  const noteLine = note ? `${F.notes} "${note.s}" ${note.bit.sourceId !== g.sourceId || note.bit.page !== g.page ? cite(note.bit.sourceId, note.bit.page) : ""}`.trim() : "";
  const anchor = c.covered[i];
  const analogy = pickAnalogy(prefs.analogy, `${g.text} ${g.correction}`, c.history, forceDifferent, F.think, local);
  const analogyLine = anchor && !forceDifferent
    ? `You already know that ${lc(noDot(clip(anchor.text, 14)))}. ${analogy} ${F.same} ${lc(claim)}.`
    : `${analogy} ${F.same} ${lc(claim)}.`;
  const levelLine =
    prefs.level === "interview-level" ? `${F.interviewLine} "${claim}." Then give one concrete example.`
      : prefs.level === "exam-level" && limit >= 200 ? `${F.examLine} ${claim}.`
        : "";
  const parts = kid ? [core, analogyLine, noteLine, levelLine] : [core, noteLine, analogyLine, levelLine];
  if (c.prefs.scope === "gaps + one example" && i === 0) parts.push(exampleFor(g, c, F));
  return render(fitParts(parts, limit), prefs.format, i);
}

function closing(c: BuddyCtx, F: Frame): string {
  return c.remaining > 0 ? F.goOn(c.remaining) : c.prefs.scope === "example question" ? `Answer out loud. ${F.back}` : F.back;
}

function opener(c: BuddyCtx, F: Frame): string {
  const good = c.covered[0];
  return good ? F.opener(lc(noDot(clip(good.text, 14)))) : F.noneRight;
}

/** Full templated buddy reply for any mode. */
export function fallbackText(c: BuddyCtx): string {
  const F = frame(c.prefs);
  const limit = wordLimit(c.prefs.length);
  const sep = "\n\n";
  const out: string[] = [];
  const cur = c.current ?? c.slice[0] ?? c.gaps[0];

  switch (c.mode) {
    case "question": {
      const q = c.question ?? "";
      const hits = (c.questionNotes ?? []).flatMap((n) => sentences(n.text).map((s) => ({ s, n, sc: overlap(q, s) }))).filter((x) => x.sc >= 0.25).sort((a, b) => b.sc - a.sc).slice(0, 2);
      if (hits.length) out.push(`${F.question} ${hits.map((h) => `"${h.s}" ${cite(h.n.sourceId, h.n.page)}`).join(" ")}`);
      else out.push(`${F.question} ${F.notInNotes}`);
      out.push(c.remaining > 0 || c.gaps.length ? F.backToGaps : F.back);
      return out.join(sep);
    }
    case "why": {
      if (!cur) return F.allDone + " " + F.back;
      const hit = bestNote(`${cur.text} ${c.question ?? ""}`, cur.notes, { prefer: /\b(because|since|so that|therefore|this is why|which means|due to|so the|otherwise|ensures?)\b/i, avoid: cur.text });
      const reason = hit ? `"${hit.s}" ${cite(hit.bit.sourceId, hit.bit.page)}` : `${noDot(cur.text)}. ${cite(cur.sourceId, cur.page)}`;
      const ana = pickAnalogy(c.prefs.analogy, cur.text, c.history, true, F.think);
      out.push(fitParts([`${F.why} ${reason}`, `${ana} That's why ${lc(noDot(cur.text))}.`], limit).join(" "));
      out.push(c.remaining > 0 ? F.goOn(c.remaining) : F.back);
      return out.join(sep);
    }
    case "example": {
      if (!cur) return F.allDone + " " + F.back;
      out.push(exampleFor(cur, c, F));
      out.push(c.remaining > 0 ? F.goOn(c.remaining) : F.back);
      return out.join(sep);
    }
    case "stuck": {
      if (!cur) return F.allDone + " " + F.back;
      const simple = { ...c, prefs: { ...c.prefs, level: "like I'm 12" } };
      out.push(F.stuck);
      out.push(gapBlock(cur, 0, simple, F, Math.min(limit, 90), true));
      out.push(F.stuckPrereq);
      out.push(F.back);
      return out.join(sep);
    }
    case "shorter": {
      const prevWords = c.prevText ? countWords(c.prevText) : limit * c.slice.length;
      const per = Math.max(15, Math.floor(prevWords / 2 / Math.max(1, c.slice.length)));
      const local: string[] = [];
      c.slice.forEach((g, i) => out.push(gapBlock(g, i, c, F, per, false, local)));
      out.push(closing(c, F));
      return out.join(sep);
    }
    case "exam_eve": {
      c.slice.forEach((g, i) => out.push(gapBlock(g, i, { ...c, prefs: { ...c.prefs, length: "very short", scope: "only my gaps" } }, F, 40, false)));
      return out.join("\n\n");
    }
    default: {
      // gaps | restyle | continue
      if (!c.slice.length) {
        if (!c.gaps.length && c.mode !== "continue") return `${c.covered.length ? opener(c, F) : F.noneRight} You covered everything here. ${F.back}`;
        return `${F.allDone} ${F.back}`;
      }
      if (c.mode !== "continue") out.push(opener(c, F));
      if (c.scopeNote) out.push(c.scopeNote === "only_wrong_none" ? F.onlyWrongNone : c.scopeNote);
      if (c.prefs.scope === "full topic" && c.mode !== "continue" && c.covered.length) {
        out.push(`${F.recap}\n${c.covered.map((k) => `- ✓ ${noDot(k.text)}.`).join("\n")}`);
      }
      const local: string[] = [];
      c.slice.forEach((g, i) => out.push(gapBlock(g, i, c, F, limit, !!c.differentAnalogy, local)));
      out.push(closing(c, F));
      return out.join(sep);
    }
  }
}

/** Yield text in small pieces so it streams like a live reply. */
export async function* streamText(text: string, delayMs = 12): AsyncGenerator<string> {
  const pieces = text.match(/\S+\s*/g) ?? [];
  for (let i = 0; i < pieces.length; i += 3) {
    yield pieces.slice(i, i + 3).join("");
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
}
