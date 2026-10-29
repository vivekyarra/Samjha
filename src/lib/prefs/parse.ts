// Pure style-command parser (spec F4). No server deps, so it can run anywhere (intent rules, tests, client).
import { PREF_DEFAULTS, type PrefKey, type Prefs } from "../types";

export type Persist = "global" | "subject" | "once";

export interface StyleCommand {
  key: PrefKey;
  value: string;
  persist: Persist;
  remove?: boolean;
  reset?: boolean;
  /** Subject named in the phrase ("for physics, always…"). Caller resolves it to a subject id. */
  subjectName?: string;
  /** "shorter" / "longer" style relative values: resolved against current prefs by the caller (see resolveRelative). */
  relative?: number;
}

export const LENGTHS = ["very short", "short", "normal", "detailed"] as const;
export const LEVELS = ["like I'm 12", "beginner", "exam-level", "interview-level"] as const;
export const FORMATS = ["conversational", "bullet points", "step-by-step", "formula-first"] as const;
export const TONES = ["chill friend", "strict senior", "hype coach"] as const;
export const SCOPES = ["only my gaps", "only what I got wrong", "gaps + one example", "full topic", "just the formula", "example question"] as const;
/** Scope values that are about the current explanation, so they apply once unless "always/from now on" is said. */
const ONE_OFF_SCOPES = new Set(["only what I got wrong", "just the formula", "example question"]);

const LANGS: Record<string, string> = {
  hinglish: "Hinglish", hindi: "Hindi", english: "English", tamil: "Tamil", telugu: "Telugu", marathi: "Marathi",
  bengali: "Bengali", bangla: "Bengali", gujarati: "Gujarati", kannada: "Kannada", malayalam: "Malayalam", punjabi: "Punjabi", urdu: "Urdu",
};

const WORLDS: [RegExp, string][] = [
  [/\bcricket(?:ing)?\b|\bipl\b|\bvirat\b|\bdhoni\b/, "cricket"],
  [/\b(?:video ?)?gam(?:e|es|ing|er)\b|\bminecraft\b|\bvalorant\b|\bpubg\b|\bbgmi\b|\bfortnite\b/, "gaming"],
  [/\bmovies?\b|\bfilms?\b|\bcinema\b|\bnetflix\b/, "movies"],
  [/\bbollywood\b/, "bollywood"],
  [/\bcook(?:ing)?\b|\bkitchen\b|\bfood\b|\brecipes?\b/, "cooking"],
  [/\bfootball\b|\bsoccer\b|\bmessi\b|\bronaldo\b/, "football"],
  [/\banime\b|\bmanga\b|\bnaruto\b|\bone piece\b/, "anime"],
  [/\bmusic\b|\bsongs?\b/, "music"],
  [/\bcars?\b|\bdriving\b|\bf1\b|\bformula one\b/, "cars"],
];

const LEN_IDX = (v: string) => Math.max(0, LENGTHS.indexOf(v as (typeof LENGTHS)[number]));

/** Shift a length value by `delta` steps (negative = shorter). */
export function resolveRelative(current: string, delta: number): string {
  const i = Math.min(LENGTHS.length - 1, Math.max(0, LEN_IDX(current) + delta));
  return LENGTHS[i];
}

function normalise(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[“”"]/g, " ")
    .replace(/\bi am\b/g, "i'm")
    .replace(/\bim\b/g, "i'm")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9'+\-.,\s]/g, " ")
    .replace(/[.,!?;:]+/g, " , ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

const ONCE_RE = /\b(?:just|only) (?:this|for this) (?:time|once|one|answer|explanation)\b|\bjust this once\b|\bthis time only\b|\bonly this time\b|\bfor now\b|\bjust for now\b|\bthis one time\b|\bfor this one\b|\bjust once\b|\bthis time\b|\bis baar\b|\bsirf (?:is|ek) baar\b/;
const ALWAYS_RE = /\bfrom now on\b|\balways\b|\bevery ?time\b|\bfrom here on\b|\bgoing forward\b|\bby default\b|\bpermanently\b|\bremember (?:that|this)\b|\bhamesha\b|\baage se\b|\bkeep (?:it|things|them|answers|explanations)\b/;

const NOT_SUBJECT = /^(?:this|that|it|now|me|you|us|real|example|short|brief|detail|details|general|everything|all subjects|every subject|everything else|the exam|exam|exams|an exam|interview|interviews|a kid|kids|points|bullets|steps|terms|simple|simple terms|easy|plain|plain english|my style|the future|future|a bit|a while|one|once|the gaps|my gaps|gaps)\b/;

/** Pull out "for physics, …" / "… in chemistry" subject scoping. Returns cleaned text. */
function extractSubject(t: string): { text: string; subject?: string; thisSubject?: boolean } {
  if (/\b(?:for|in) (?:this|the current) (?:subject|course|class)\b/.test(t)) {
    return { text: t.replace(/\b(?:for|in) (?:this|the current) (?:subject|course|class)\b/, " "), thisSubject: true };
  }
  const tryName = (raw: string) => {
    const name = raw.replace(/\b(?:my|the)\b/g, " ").replace(/\b(?:subject|class|course|notes|only)\b/g, " ").replace(/\s+/g, " ").trim();
    if (!name || name.length < 2 || NOT_SUBJECT.test(name) || LANGS[name] || WORLDS.some(([re]) => re.test(name))) return undefined;
    if (/^(?:terms of|a |an |like |with |using |hindi|hinglish|english|points|bullet|steps?|step|detail|short|order|general)/.test(name)) return undefined;
    if (name.split(" ").length > 4) return undefined;
    return name;
  };
  // leading: "for physics, always …", "in chemistry use …", "when studying maths …"
  const lead = t.match(/^ (?:and |also |ok |okay )?(?:for|in|when (?:studying|doing|it's)|whenever (?:it's|i study)|only for|only in) ((?:[a-z0-9+\-']+ ?){1,5}?)(?: , | (?=always|from now|use|explain|be |keep|go |do |give|make|answer|talk|speak|i want|please|start|put|only))/);
  if (lead) {
    const s = tryName(lead[1]);
    if (s) return { text: " " + t.slice(lead[0].length), subject: s };
  }
  // trailing: "always formula first for physics", "use cricket analogies in chemistry"
  const trail = t.match(/ (?:for|in|when studying|only for|only in) ((?:[a-z0-9+\-']+ ?){1,4}?)(?: (?:only|from now on|always|please))? (?:, )?$/);
  if (trail) {
    const s = tryName(trail[1]);
    if (s) return { text: t.slice(0, t.length - trail[0].length) + " ", subject: s };
  }
  return { text: t };
}

type Found = Omit<StyleCommand, "persist"> & { oneOff?: boolean };

function findLanguage(t: string): Found | null {
  const m = t.match(/\b(hinglish|hindi|english|tamil|telugu|marathi|bengali|bangla|gujarati|kannada|malayalam|punjabi|urdu)\b/);
  if (!m) return null;
  return { key: "language", value: LANGS[m[1]] };
}

function findAnalogy(t: string): Found | null {
  const hasAnalogyWord = /\banalog(?:y|ies)\b|\bmetaphors?\b|\bcomparisons?\b|\bcompare\b|\brelate\b|\bin terms of\b|\bexamples? from\b|\bexamples\b|\bse samjhao\b|\bke example\b|\bwala example\b|\blike (?:a |an )?\w+ (?:match|game|movie|scene|recipe)\b/.test(t);
  for (const [re, world] of WORLDS) if (re.test(t)) {
    if (hasAnalogyWord || /\b(?:use|using|with|via|through)\b/.test(t) || t.trim().split(" ").length <= 3) return { key: "analogy", value: world };
  }
  if (!hasAnalogyWord) return null;
  if (/\breal(?:-| )?(?:life|world)\b|\beveryday\b|\bdaily life\b/.test(t)) return { key: "analogy", value: "everyday life" };
  const free =
    t.match(/\b(?:use|using|with|give me|try|want) (?:an? |some |the )?((?:[a-z']+ ){1,3}?)(?:analog(?:y|ies)|metaphors?|comparisons?|examples)\b/) ||
    t.match(/\b(?:analog(?:y|ies)|metaphors?|examples?) (?:from|about|with|of|based on) (?:an? |the )?((?:[a-z']+ ?){1,3})/) ||
    t.match(/\bin terms of (?:an? |the )?((?:[a-z']+ ?){1,3})/) ||
    t.match(/\b(?:compare|relate) (?:it|this|that|them|things)? ?(?:to|with) (?:an? |the )?((?:[a-z']+ ?){1,3})/);
  if (!free) return null;
  const w = free[1].replace(/\b(?:please|from|now|on|always|a|an|the|some|more|real|life|world|one)\b/g, " ").replace(/[,\s]+/g, " ").trim();
  if (!w || /^(?:different|another|new|better|simple|simpler|other|good|nice|example|question)$/.test(w)) return null;
  return { key: "analogy", value: w };
}

function findLength(t: string): Found | null {
  if (/\b(?:much|way|lot|bahut|super|really|very|even|extra) (?:shorter|short|brief|briefer)\b|\btl ?dr\b|\bone (?:line|liner|sentence)\b|\bin a nutshell\b|\bbare minimum\b/.test(t))
    return /\b(?:keep|always|from now on|every ?time|default)\b/.test(t) ? { key: "length", value: "very short" } : { key: "length", value: "shorter", relative: -2 };
  if (/\bshorter\b|\bless words\b|\bfewer words\b|\bbriefer\b|\bmore concise\b|\bcut it down\b|\bchhota\b|\bchota\b|\btoo long\b/.test(t))
    return { key: "length", value: "shorter", relative: -1 };
  if (/\b(?:much|way|lot|a lot|bahut) (?:longer|more detail(?:ed)?)\b|\bin depth\b|\bin-depth\b|\bdeep dive\b|\bvery detailed\b|\bfull detail\b/.test(t))
    return /\b(?:always|from now on|every ?time|default)\b/.test(t) ? { key: "length", value: "detailed" } : { key: "length", value: "longer", relative: 2 };
  if (/\blonger\b|\bmore detail(?:s|ed)?\b|\belaborate\b|\bexpand\b|\bin detail\b|\bdetail mein\b|\btoo short\b|\bgo deeper\b/.test(t))
    return { key: "length", value: "longer", relative: 1 };
  if (/\bvery short\b|\bsuper short\b/.test(t)) return { key: "length", value: "very short" };
  if (/\bdetailed\b/.test(t)) return { key: "length", value: "detailed" };
  if (/\b(?:normal|medium|regular|default) length\b/.test(t)) return { key: "length", value: "normal" };
  if (/\b(?:keep it|be|short and) (?:short|brief|concise)\b|\bshort answers?\b|\bconcise\b|\bbrief\b|\bshort\b/.test(t)) return { key: "length", value: "short" };
  return null;
}

function findLevel(t: string): Found | null {
  if (/\blike i'm (?:a )?(?:\d{1,2}|five|ten|twelve|kid|child|baby)\b|\b(?:\d{1,2}|five|ten|twelve) year old\b|\beli5\b|\blike a (?:kid|child)\b|\bsimple (?:words|terms|language)\b|\bdumb it down\b|\bsimplify\b|\bsimpler\b|\bsuper simple\b|\bin plain english\b|\beasy (?:words|language)\b|\baasan\b/.test(t))
    return { key: "level", value: "like I'm 12" };
  if (/\bbeginner\b|\bnewbie\b|\bnew to this\b|\bfrom (?:the )?(?:basics|scratch)\b|\bbasic level\b/.test(t)) return { key: "level", value: "beginner" };
  if (/\binterview(?:-| )?(?:level|style|ready|mode|answer|answers)?\b|\bplacement\b|\blike an interviewer\b/.test(t))
    return { key: "level", value: "interview-level" };
  if (/\bexam(?:-| )?(?:level|style|ready|answer|answers|oriented|point of view)\b|\bfor (?:the )?exams?\b|\bboard exam\b|\bwrite in (?:the )?exam\b|\bmarks\b/.test(t))
    return { key: "level", value: "exam-level" };
  return null;
}

function findFormat(t: string): Found | null {
  if (/\b(?:no|without|stop(?: using)?|don't use|dont use) (?:the )?(?:bullets?|bullet points|points|lists?)\b|\bconversational\b|\btalk normally\b|\blike a conversation\b|\bin paragraphs?\b|\bprose\b/.test(t))
    return { key: "format", value: "conversational" };
  if (/\bbullet(?:ed)?(?: points?)?\b|\bbullets\b|\bpoint ?wise\b|\bin points\b|\bas a list\b|\blist (?:form|format)\b/.test(t)) return { key: "format", value: "bullet points" };
  if (/\bstep[- ]by[- ]step\b|\bin steps\b|\bstepwise\b|\bone step at a time\b/.test(t)) return { key: "format", value: "step-by-step" };
  if (/\bformulas? first\b|\bformula[- ]first\b|\bstart with (?:the )?formulas?\b|\blead with (?:the )?formulas?\b|\bequations? first\b/.test(t))
    return { key: "format", value: "formula-first" };
  return null;
}

function findTone(t: string): Found | null {
  if (/\bstrict\b|\bsenior\b|\bharsh\b|\bbrutal\b|\bno sugar ?coat|\btough love\b|\bbe serious\b|\bscold\b/.test(t)) return { key: "tone", value: "strict senior" };
  if (/\bhype\b|\bcoach\b|\bmotivat|\benergetic\b|\bpump me up\b|\bexcited\b|\bcheer\b|\bjosh\b/.test(t)) return { key: "tone", value: "hype coach" };
  if (/\bchill\b|\bfriendly\b|\bcasual\b|\brelaxed\b|\blike a friend\b|\bbe nice\b|\bgentle\b/.test(t)) return { key: "tone", value: "chill friend" };
  return null;
}

function findScope(t: string): Found | null {
  if (/\b(?:only|just) (?:the )?(?:parts?|bits?|things?|ones?|stuff|points?)? ?(?:that )?i (?:got|get|had) wrong\b|\b(?:only|just) (?:the |my )?(?:wrong (?:parts?|ones?|bits?|answers?|stuff)|mistakes)\b|\bonly what i got wrong\b|\bjust my mistakes\b|\bsirf galti\b/.test(t))
    return { key: "scope", value: "only what I got wrong", oneOff: true };
  if (/\bgaps? (?:plus|and|\+|with) (?:one |an |a )?examples?\b|\bgaps? \+ one example\b|\b(?:plus|and) (?:one|an) example (?:each|too|as well)\b/.test(t))
    return { key: "scope", value: "gaps + one example" };
  if (/\b(?:just|only) (?:the |my )?(?:gaps|missing (?:parts?|bits?|stuff)|what i missed)\b|\bonly my gaps\b/.test(t)) return { key: "scope", value: "only my gaps" };
  if (/\b(?:full|whole|entire|complete) (?:topic|thing|chapter|concept)\b|\bexplain everything\b|\bfrom the start\b|\bcover everything\b/.test(t))
    return { key: "scope", value: "full topic" };
  if (/\b(?:just|only) (?:the |give me the )?(?:formulas?|equations?)\b|\bformulas? only\b|\bgive me the formula\b|\bsirf formula\b/.test(t))
    return { key: "scope", value: "just the formula", oneOff: true };
  if (/\b(?:example|practice|sample|exam|quiz|test|check) (?:question|questions|problem|problems)\b|\bquiz me\b|\btest me\b|\bask me a question\b/.test(t))
    return { key: "scope", value: "example question", oneOff: true };
  return null;
}

const FINDERS = [findScope, findFormat, findLanguage, findLevel, findTone, findLength, findAnalogy];

const KEY_WORDS: [RegExp, PrefKey][] = [
  [/\b(?:language)\b/, "language"],
  [/\b(?:analog(?:y|ies)|metaphors?|comparisons?)\b/, "analogy"],
  [/\b(?:length)\b/, "length"],
  [/\b(?:level|difficulty)\b/, "level"],
  [/\b(?:format|formatting|bullets?|bullet points|steps|step by step)\b/, "format"],
  [/\b(?:tone|attitude|vibe)\b/, "tone"],
  [/\b(?:scope)\b/, "scope"],
];

/** Parse every style instruction in one utterance (e.g. "Hinglish with cricket analogies, shorter"). */
export function parseStyleCommands(text: string): StyleCommand[] {
  if (!text || !text.trim()) return [];
  const raw = normalise(text);
  if (raw.trim().split(" ").length > 28) return [];

  // reset everything
  if (/\b(?:reset|clear|wipe|forget|remove|delete|undo) (?:all )?(?:of )?(?:my |the |your )?(?:style|styles|preferences|prefs|settings for style|everything about (?:my )?style)\b|\b(?:back to|use) (?:the )?default style\b|\bstart fresh\b|\breset (?:it )?all\b|\breset everything\b/.test(raw)) {
    return [{ key: "language", value: "", persist: "global", reset: true }];
  }

  const once = ONCE_RE.test(raw);
  const always = ALWAYS_RE.test(raw);
  const subj = extractSubject(raw);
  let t = subj.text.replace(ONCE_RE, " ");
  const persistFor = (f: Found): Persist =>
    subj.subject || subj.thisSubject ? "subject" : once ? "once" : always ? "global" : f.oneOff || f.relative ? "once" : "global";
  const withSubject = (c: StyleCommand): StyleCommand => (subj.subject && c.persist === "subject" ? { ...c, subjectName: subj.subject } : c);

  // removal: "stop using cricket", "no more analogies", "remove tone", "don't use bullet points"
  const rm = t.match(/\b(?:stop|quit|no more|drop|remove|forget|clear|reset|don't use|dont use|do not use|don't do|no|enough (?:with|of)|band karo|mat (?:karo|use karo))\b(.*)$/);
  if (rm && !/\bstop (?:being|talking|speaking)? ?(?:so )?(?:long|short)\b/.test(t)) {
    const rest = ` ${rm[1]} `;
    const restClean = rest.replace(/\b(?:using|the|those|these|my|your|with|being|so|please|in|speaking|talking|explaining)\b/g, " ");
    const out: StyleCommand[] = [];
    // "no bullets" means conversational, handled by findFormat as a set
    if (!/\b(?:bullets?|bullet points|points|lists?)\b/.test(rest) || /\b(?:remove|reset|forget|clear)\b/.test(rm[0])) {
      for (const [re, key] of KEY_WORDS) if (re.test(rest)) {
        const world = key === "analogy" ? WORLDS.find(([w]) => w.test(rest))?.[1] ?? "" : "";
        out.push({ key, value: world, persist: "global", remove: true });
      }
      if (!out.length) {
        for (const f of [findAnalogy, findLanguage, findTone, findFormat, findLevel, findLength, findScope]) {
          const r = f(restClean.includes("analog") ? restClean : `${restClean} analogies `);
          if (r && r.key !== "length" && !out.some((o) => o.key === r.key)) out.push({ key: r.key, value: r.value, persist: "global", remove: true });
          if (out.length) break;
        }
      }
      if (out.length) {
        const p: Persist = subj.subject || subj.thisSubject ? "subject" : "global";
        return out.map((c) => withSubject({ ...c, persist: p }));
      }
    }
  }

  const found: Found[] = [];
  for (const f of FINDERS) {
    const r = f(t);
    if (r && !found.some((x) => x.key === r.key)) {
      found.push(r);
      // stop formula-first from also matching "just the formula" etc.
      if (r.key === "scope" && r.value === "just the formula") t = t.replace(/formulas?|equations?/g, " ");
      if (r.key === "scope" && r.value === "gaps + one example") t = t.replace(/examples?/g, " ");
      if (r.key === "scope" && r.value === "example question") t = t.replace(/examples?|questions?/g, " ");
      if (r.key === "format" && r.value === "formula-first") t = t.replace(/formulas?/g, " ");
    }
  }
  return found.map((f) =>
    withSubject({
      key: f.key,
      value: f.value,
      persist: persistFor(f),
      ...(f.relative ? { relative: f.relative } : {}),
    }),
  );
}

/** Contract: first (primary) style command in the text, or null. */
export function parseStyleCommand(text: string): StyleCommand | null {
  return parseStyleCommands(text)[0] ?? null;
}

const KEY_LABEL: Record<PrefKey, string> = {
  language: "Language", analogy: "Analogies", length: "Length", level: "Level", format: "Format", tone: "Tone", scope: "Scope",
};
export const prefLabel = (k: PrefKey) => KEY_LABEL[k];

function describe(key: PrefKey, value: string): string {
  switch (key) {
    case "analogy": return `${value} analogies`;
    case "language": return value;
    case "length": return value === "very short" ? "very short answers" : value === "detailed" ? "detailed answers" : `${value} answers`;
    case "level": return value === "like I'm 12" ? "explaining like you're 12" : value;
    case "format": return value;
    case "tone": return value === "strict senior" ? "strict senior mode" : value === "hype coach" ? "hype coach mode" : "chill friend mode";
    case "scope":
      return value === "only what I got wrong" ? "only the parts you got wrong"
        : value === "just the formula" ? "just the formula"
        : value === "example question" ? "an example question"
        : value === "gaps + one example" ? "your gaps plus one example"
        : value;
  }
}

/** One short confirmation line (spec F4 "Got it, cricket analogies from now on."). */
export function confirmationFor(cmds: (StyleCommand & { value: string })[], subjectLabel?: string): string {
  if (!cmds.length) return "I didn't catch a style change there. Try \"use cricket analogies\" or \"shorter\".";
  if (cmds.some((c) => c.reset)) return "Done, your style is back to the defaults.";
  const removes = cmds.filter((c) => c.remove);
  if (removes.length) {
    const what = removes.map((c) => (c.key === "analogy" ? (c.value ? `${c.value} analogies` : "analogies") : `custom ${KEY_LABEL[c.key].toLowerCase()}`)).join(" and ");
    const back = removes.length === 1 && removes[0].key !== "analogy" ? `, back to ${PREF_DEFAULTS[removes[0].key]}` : "";
    return `Done, no more ${what}${back}${subjectLabel ? ` in ${subjectLabel}` : ""}.`;
  }
  const parts = cmds.map((c) => describe(c.key, c.value));
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  const p = cmds[0].persist;
  if (p === "once") return `Okay, ${list} just this time.`;
  if (p === "subject") return `Got it, ${list} for ${subjectLabel ?? "this subject"}.`;
  return `Got it, ${list} from now on.`;
}

export type { Prefs };
