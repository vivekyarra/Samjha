// Pure grading logic for Samjha (spec F2, §8.3). No server-only / db imports so eval/run.ts can run it with tsx.
// Contains: the model prompt + response schema, post-validation of model output, and the built-in grading engine.
import { z } from "zod";
import type { ClaimGrade, ClaimStatus, GradeResult, Misconception } from "../types";

export const GRADER_VERSION = "builtin-v6";

export interface GradeClaimInput { id: string; text: string; page: number | null }
export interface GradeChunkInput { text: string; page: number | null; sourceId?: string | null; fileName?: string }
export interface GradeInput {
  topic: string;
  /** All claims of the topic (used for context and term weighting). */
  claims: GradeClaimInput[];
  /** Grade only these claim ids (default: all). */
  only?: string[];
  chunks: GradeChunkInput[];
  explanation: string;
  appeal?: { claimId: string; note: string };
}

/* ------------------------------------------------------------------ */
/* Claude prompt + schema                                              */
/* ------------------------------------------------------------------ */

const pageSchema = z.preprocess((v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v).replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}, z.number().nullable());
const str = z.string().nullish().transform((v) => v ?? "");

export const gradeResponseSchema = z.object({
  claims: z.array(
    z.object({
      claim_id: z.string(),
      status: z.enum(["covered", "missing", "wrong"]),
      evidence: str,
      correction: str,
      page: pageSchema.optional().transform((v) => v ?? null),
    }),
  ),
  misconceptions: z
    .array(z.object({ quote: z.string(), correction: str, page: pageSchema.optional().transform((v) => v ?? null) }))
    .nullish()
    .transform((v) => v ?? []),
  strengths: z.array(z.string()).nullish().transform((v) => v ?? []),
  not_in_notes: z.array(z.string()).nullish().transform((v) => v ?? []),
});
export type GradeResponse = z.output<typeof gradeResponseSchema>;

const SYSTEM = `You are Samjha's grader. A student explained a topic out loud (speech transcript: informal, may be Hinglish, may ramble). You grade it claim by claim against the student's own notes.

For EACH claim return a status:
- "covered": the student clearly states the idea of the claim, in any words.
- "wrong": the student says something about the claim's idea that contradicts the notes.
- "missing": the student doesn't address the claim, or only mentions it so vaguely it would not earn the mark in an exam.

Rules:
- Judge meaning, not keywords. Paraphrases, analogies, Hinglish and informal wording count as covered when the idea is right.
- If a statement is partly right, mark it "wrong" only if the error would lose marks in an exam; otherwise "covered".
- Never mark something wrong that the notes support. Use only the notes as the source of truth, never outside knowledge.
- "evidence": for covered and wrong, copy the student's exact words: a contiguous, verbatim substring of the explanation (usually one sentence or clause). Do not fix typos or paraphrase. Empty string for missing.
- "correction": for wrong only, one sentence saying what the notes say. Empty otherwise.
- "page": the notes page that supports the claim (use the page given with the claim).
- "misconceptions": other incorrect statements in the explanation that don't belong to any claim but contradict the notes. Quote verbatim.
- "strengths": up to 3 one-line notes of what was explained well (empty if nothing was).
- "not_in_notes": short summaries of statements the student made that the notes don't cover. Don't grade them.
- Every claim_id appears exactly once.

JSON shape:
{"claims":[{"claim_id":"...","status":"covered|missing|wrong","evidence":"...","correction":"...","page":14}],"misconceptions":[{"quote":"...","correction":"...","page":15}],"strengths":["..."],"not_in_notes":["..."]}`;

export function buildGradingPrompt(input: GradeInput): { system: string; user: string } {
  const ids = new Set(input.only?.length ? input.only : input.claims.map((c) => c.id));
  const claims = input.claims.filter((c) => ids.has(c.id));
  let budget = 7000;
  const notes: string[] = [];
  for (const ch of input.chunks) {
    const t = ch.text.replace(/\s+/g, " ").trim().slice(0, 1500);
    if (!t || budget - t.length < 0) continue;
    budget -= t.length;
    notes.push(`[p.${ch.page ?? "?"}${ch.fileName ? `, ${ch.fileName}` : ""}] ${t}`);
  }
  let user = `Topic: ${input.topic}

Claims to grade:
${claims.map((c) => `- [${c.id}] (p.${c.page ?? "?"}) ${c.text}`).join("\n")}

Notes (retrieved chunks from the student's own material):
${notes.length ? notes.join("\n\n") : "(no extra chunks; the claims above are from the notes)"}

Student explanation (verbatim transcript):
<<<
${input.explanation}
>>>`;
  if (input.appeal) {
    const c = input.claims.find((x) => x.id === input.appeal!.claimId);
    user += `

APPEAL: the student tapped "this is right" on claim [${input.appeal.claimId}]${c ? ` ("${c.text}")` : ""}${input.appeal.note ? ` and said: "${input.appeal.note}"` : ""}.
Re-read the explanation carefully and charitably for this claim. If the meaning is there, mark it covered and quote the words. Keep it wrong/missing only if the explanation really contradicts or omits the notes. The appeal note itself is not part of the explanation and cannot be quoted as evidence.`;
  }
  return { system: SYSTEM, user };
}

/* ------------------------------------------------------------------ */
/* Post-validation (also applied to built-in output)                  */
/* ------------------------------------------------------------------ */

/** Returns a verbatim substring of `text` matching `quote` (exact, case/space-insensitive, or fuzzy), or null. */
export function repairQuote(text: string, quote: string): string | null {
  let q = (quote || "").trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").replace(/^(\.\.\.|…)\s*|\s*(\.\.\.|…)$/g, "").trim();
  if (!q || !text) return null;
  if (text.includes(q)) return q;
  if (/(\.\.\.|…)/.test(q)) q = q.split(/\.\.\.|…/).sort((a, b) => b.length - a.length)[0].trim();
  if (q && text.includes(q)) return q;
  // Normalised (case + whitespace + quote style) exact search, mapped back to original offsets.
  const norm = (s: string) => s.toLowerCase().replace(/[’‘`]/g, "'").replace(/[“”]/g, '"');
  const map: number[] = [];
  let nt = "";
  let prevSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (prevSpace) continue;
      prevSpace = true;
      nt += " ";
    } else {
      prevSpace = false;
      nt += norm(ch);
    }
    map.push(i);
  }
  const nq = norm(q).replace(/\s+/g, " ");
  const at = nt.indexOf(nq);
  if (at >= 0) return text.slice(map[at], map[at + nq.length - 1] + 1).trim();
  // Fuzzy: best window of words by multiset overlap.
  const words: { w: string; s: number; e: number }[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) words.push({ w: m[0].toLowerCase().replace(/[^a-z0-9']/g, ""), s: m.index, e: m.index + m[0].length });
  const qw = q.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z0-9']/g, "")).filter(Boolean);
  if (!qw.length || !words.length) return null;
  let best = { f: 0, i: 0, j: 0 };
  for (let len = Math.max(1, qw.length - 3); len <= qw.length + 3; len++) {
    for (let i = 0; i + len <= words.length; i++) {
      const bag = new Map<string, number>();
      for (const w of qw) bag.set(w, (bag.get(w) ?? 0) + 1);
      let common = 0;
      for (let k = i; k < i + len; k++) {
        const c = bag.get(words[k].w) ?? 0;
        if (c > 0) {
          common++;
          bag.set(words[k].w, c - 1);
        }
      }
      const f = common / Math.max(qw.length, len);
      if (f > best.f) best = { f, i, j: i + len - 1 };
    }
  }
  if (best.f < 0.6) return null;
  return text.slice(words[best.i].s, words[best.j].e).replace(/[,;:]+$/, "").trim();
}

/** Validate/repair a raw grading response: verbatim evidence, every claim exactly once, pages filled. */
export function finalizeResult(raw: GradeResponse, input: GradeInput): GradeResult {
  const ids = input.only?.length ? input.only : input.claims.map((c) => c.id);
  const byId = new Map(input.claims.map((c) => [c.id, c]));
  const got = new Map<string, GradeResponse["claims"][number]>();
  for (const r of raw.claims) {
    const id = r.claim_id.trim().replace(/^\[|\]$/g, "");
    if (byId.has(id) && !got.has(id)) got.set(id, r);
  }
  const claims: ClaimGrade[] = [];
  for (const id of ids) {
    const c = byId.get(id);
    if (!c) continue;
    const r = got.get(id);
    let status: ClaimStatus = r?.status ?? "missing";
    let evidence = "";
    let correction = "";
    if (r && status !== "missing") {
      const ev = repairQuote(input.explanation, r.evidence);
      if (!ev) status = "missing";
      else evidence = ev;
    }
    if (status === "wrong") correction = (r?.correction || "").trim() || c.text;
    claims.push({ claim_id: id, status, evidence, correction, page: r?.page ?? c.page ?? null });
  }
  const misconceptions: Misconception[] = [];
  const seen = new Set<string>();
  for (const m of raw.misconceptions) {
    const q = repairQuote(input.explanation, m.quote);
    if (!q || seen.has(q)) continue;
    seen.add(q);
    misconceptions.push({ quote: q, correction: m.correction.trim(), page: m.page ?? null });
  }
  const strengths = raw.strengths.map((s) => s.trim()).filter(Boolean).slice(0, 4);
  const not_in_notes = raw.not_in_notes.map((s) => s.trim()).filter(Boolean).slice(0, 5);
  return { claims, misconceptions: misconceptions.slice(0, 5), strengths, ...(not_in_notes.length ? { not_in_notes } : {}) };
}

/* ------------------------------------------------------------------ */
/* Built-in grading engine (no API key needed)                        */
/* ------------------------------------------------------------------ */

const STOP = new Set(
  `a an the is are was were be been being am of to in on at for with by from as that this these those it its it's they them their there here
  and but so if then than too very really just quite we you i he she our your my me us his her can could would should will shall may might must
  do does did done doing have has had having what which who whom how when where why about into onto up over also like okay ok yeah um uh hmm
  thing things basically actually called use used using uses usually make makes made get gets got go goes going went take takes taking took one
  way some such other another most much many lot lots say says said know means mean meaning kind sort bit whatever etc ie eg
  model models simply just let lets need needs try tries want wants come comes keep keeps give gives put while whereas because since though
  even still again already only each every all any both either per via around until till once twice then therefore thus hence
  hai hain ho hota hoti hote hua hui toh to ki ka ke ko se mein me main pe par aur ya jab tab ye yeh woh wo isko iska iski uska uski uske unka
  hum ham rakha rakho rakhte rakhna rakhoge karte karta karti karo kar karke karna karne lete leta leti lo jaata jaati jaate jata jate hoga hogi honge matlab yaani yani dekho
  simple yaar bhi sirf bas jaise agar phir fir liye wala wali wale sakta sakti sakte ek kuch thoda thodi sa si bahut kaafi raha rahi rahe
  nikalo nikalta nikalte nikalne milta milti mil chalate chalata lagaake lagake lagate lagta lagti taaki taki tak hi waha yaha jo jaisa kitne
  respect set sets case cases time times? point example examples instance problem problems task tasks likely usually often commonly normally typically generally
  amount standard choice works work`
    .split(/\s+/)
    .filter((w) => w && !w.endsWith("?")),
);

// Ordered phrase rewrites (applied to lowercased text) to canonical tokens.
const PHRASES: [RegExp, string][] = (
  [
    [String.raw`\b([fgh])\s*'`, " $1 _grad "],
    [String.raw`\bd[a-z]?\s*/\s*d[a-z]\b`, " _grad "],
    [String.raw`\b(?:do|does|did|is|are|was|were|could|should|would|has|have|had|wo|ca|need)n'?t\b`, " _not "],
    [String.raw`\b(?:cannot|can not|not|never|no|without|instead of|rather than|neither|nor)\b`, " _not "],
    [String.raw`\b(?:nahi|nahin|nahii|nai|mat)\b`, " _npost "],
    [String.raw`\b(?:stochastic gradient descent|mini-?batch sgd|sgd)\b`, " _sgd "],
    [String.raw`\bsteepest descent\b`, " _opposite "],
    [String.raw`\bgradient descent\b`, " _gd "],
    [String.raw`\b(?:back[- ]?propagation|backprop|back[- ]prop)\b`, " _backprop "],
    [String.raw`\bchain rule\b`, " _chain "],
    [String.raw`\bstep[- ]sizes?\b`, " _size _update "],
    [String.raw`\b(?:learning[- ]rates?|lr|alpha|eta)\b`, " _lr "],
    [String.raw`\b(?:how big|how large|how small|kitna bada|kitna bara|kitna|kitni|how much|magnitude)\b`, " _size "],
    [String.raw`\b(?:how far|how wrong|how off|how different|kitna door|kitna galat)\b`, " _diff "],
    [String.raw`\b(?:weight decay|l[12] regulari[sz]ation|l[12] penalty)\b`, " _reg "],
    [String.raw`\b(?:mean squared? errors?|squared errors?|l2 loss|mse)\b`, " _mse "],
    [String.raw`\b(?:cross[- ]?entropy|log loss|logistic loss|ce loss)\b`, " _ce "],
    [String.raw`\b(?:early[- ]stopping|stop(?:ping)? (?:the )?(?:training )?early|early stop)\b`, " _early_stop "],
    [String.raw`\b(?:train(?:ing)? (?:it )?(?:for )?longer|more epochs|zyada epochs|keep training|train (?:it )?more)\b`, " _longer "],
    [String.raw`\b(?:too many parameters|lots of parameters|many parameters|high capacity|too flexible)\b`, " _complex "],
    [String.raw`\b(?:too few parameters|few parameters|low capacity)\b`, " _simple "],
    [String.raw`\b(?:opposite|against|reverse|negative|ulta|ulti|ulte)\s+(?:to\s+|of\s+)?(?:the\s+)?(?:direction\s+)?(?:of\s+|to\s+)?(?:the\s+)?(?:gradient|slope)s?\b`, " _opposite _grad "],
    [String.raw`\b(?:gradient|slope)\s+(?:ki|ke|ka)\s+(?:opposite|ulta|ulti|ulte|against)\b`, " _grad _opposite "],
    [String.raw`\b(?:gradient|slope)\s+(?:ki|ke|ka)\s+direction\b`, " _grad _same "],
    [String.raw`\bdirection\s+of\s+(?:the\s+)?(?:gradient|slope)\b`, " _same _grad "],
    [String.raw`\b(?:along|towards|toward)\s+(?:the\s+)?(?:gradient|slope)\b`, " _same _grad "],
    [String.raw`\b(?:same direction|uphill|up the hill|up the slope|steepest ascent)\b`, " _same "],
    [String.raw`\b(?:downhill|down the hill|down the slope)\b`, " _opposite "],
    [String.raw`\b(?:subtract(?:ing|s|ed)?|minus)\b`, " _opposite "],
    // Update rules like "w = w - lr * grad" / "w := w + ...".
    [String.raw`:?=\s*([a-z]\w*)\s+-\s+`, " = $1 _opposite "],
    [String.raw`:?=\s*([a-z]\w*)\s+\+\s+`, " = $1 _same "],
    [String.raw`\b(?:away from|in the reverse of)\s+(?:the\s+)?(?:gradient|slope)\b`, " _opposite _grad "],
    [String.raw`\b(?:follow(?:s|ing)?|go(?:es|ing)? with|chase|chasing)\s+(?:the\s+)?(?:gradient|slope)\b`, " _same _grad "],
    [String.raw`\b(?:layer'?s outputs?|outputs? of (?:each|every|all|the|har) layers?|intermediate (?:values|outputs|results)|activations?)\b`, " _activation "],
    [String.raw`\b(?:first layer|input layer|towards the first|to the first|start of the network)\b`, " _input layer "],
    [String.raw`\b(?:last layer|final layer|output layer|end of the network|from the end)\b`, " _output layer "],
    [String.raw`\b(?:forward pass|forward propagation|run (?:the )?inputs? through(?: the network)?|through the network)\b`, " _forward _pass "],
    [String.raw`\bbackward pass\b`, " _backward _pass "],
    [String.raw`\b(?:function (?:inside|within|of|ke andar|ke ander) (?:another |a |an |ek )?function|nested functions?|composite|composition|composed)\b`, " _composite "],
    [String.raw`\b(?:neural net(?:work)?s?|networks?|nets?)\b`, " _nn "],
    [String.raw`\b(?:training (?:set|data|dataset|examples)|train data)\b`, " _train _data "],
    [String.raw`\b(?:unseen data|new data|held[- ]out data|test (?:set|data)|validation (?:set|data))\b`, " _test _data "],
    [String.raw`\b(?:as (?:small|low) as possible|minimum karna|minimum karte|kam karna|kam karte|kam karta)\b`, " _decrease "],
    [String.raw`\b(?:as (?:large|high|big) as possible|maximum karna|maximum karte)\b`, " _increase "],
    [String.raw`\b(?:blow(?:s|ing)? up|paar (?:chale|chala|chali|nikal)\w*|jump(?:s|ing)? over|miss(?:es)? the minimum|bounc\w* around|never settles?)\b`, " _diverge "],
    [String.raw`\b(?:takes? (?:forever|ages|a long time|very long)|long time|bahut (?:time|der))\b`, " _slow "],
    [String.raw`\b(?:real[- ]valued|continuous (?:values|outputs?|numbers)|predicting numbers)\b`, " _regress "],
    [String.raw`\b(?:ground truth|actual values?|true values?|correct answers?|real values?|asli values?|actual labels?)\b`, " _true "],
    [String.raw`\b(?:random subset|small subset|few examples|part of the data|chhota batch|small batch|mini[- ]?batch(?:es)?)\b`, " _batch "],
    [String.raw`\b(?:full batch|entire dataset|whole dataset|full dataset|all the data|all data|poora data|pura data|entire data)\b`, " _whole _data "],
    [String.raw`\b(?:real|underlying|general|true|actual)\s+patterns?\b`, " _general _pattern "],
    [String.raw`\b(?:perform(?:s|ing)?|does|do)\s+(?:badly|poorly)\b`, " _bad "],
    [String.raw`\b(?:perform(?:s|ing)?|does|do)\s+well\b`, " _good "],
    [String.raw`\b(?:goes up|go up|badhta|badh jata|badh jaata)\b`, " _increase "],
    [String.raw`\b(?:goes down|go down|ghatta)\b`, " _decrease "],
    [String.raw`\b(?:by heart|mug up|ratta)\b`, " _learn "],
    [String.raw`\b(?:more|less|most) likely\b|\bamount of\b`, " "],
    [String.raw`\bhow far (?:you|we|it|the model) (?:step|steps|move|moves|go|goes)\b`, " _size _update "],
    [String.raw`\b(?:is|are) set by\b`, " _control "],
    [String.raw`\b(?:different (?:\w+ )?from|not the same as)\b`, " _not "],
    [String.raw`\b(?:bigger|larger|smaller|tinier|huge|big|small|large|tiny)\s+(?:steps?|jumps?|updates?|moves?|leaps?|strides?)\b`, " _size _update "],
    [String.raw`\b(?:reach(?:es|ing)?|get(?:s|ting)? to|find(?:s|ing)?)\s+(?:the\s+|a\s+|an\s+)?(?:better\s+|good\s+|global\s+|lower\s+|best\s+)?(?:minimum|bottom|optimum|lowest point)\b`, " _converge _minimum "],
    [String.raw`\b(?:barely|hardly)\s+(?:moves?|changes?|updates?|budges?|improves?)\b`, " _slow "],
    [String.raw`\b(?:huge|large|big|massive|enormous)\s+number\s+of\s+(?:iterations|steps|epochs|updates)\b`, " _slow "],
    [String.raw`\b(?:start(?:s|ing)?|go(?:es|ing)?|begin(?:s|ning)?)\s+(?:from|at)\s+the\s+(?:loss|error)\b`, " _output _loss "],
    [String.raw`\b(?:outer|outside|bahar wale|bahar wala|bahar ka|bahar ke)\s+function\b`, " _outer f function "],
    [String.raw`\b(?:inner|inside|andar wale|andar wala|andar ka|andar ke)\s+function\b`, " _inner g x function "],
    // Absolute qualifiers: restrict an idea to one case.
    [String.raw`\b(?:only|solely|exclusively|always|sirf|keval|hamesha|in all cases|in every case|guaranteed to|guarantees?)\b`, " _abs "],
    // General academic / ML paraphrases.
    [String.raw`\b(?:single (?:example|sample|data point)|one (?:example|sample|data point) at a time|ek (?:example|sample))\b`, " _batch "],
    [String.raw`\b(?:works? (?:well )?on new data|generali[sz]es? well)\b`, " _general _test "],
    [String.raw`\b(?:fails? on|struggles? (?:on|with)|kharab perform)\b`, " _bad "],
    [String.raw`\b(?:bring(?:s|ing)? down|push(?:es|ing)? down|make(?:s)? (?:it )?smaller|cut(?:s|ting)? down)\b`, " _decrease "],
    [String.raw`\b(?:push(?:es|ing)? up|make(?:s)? (?:it )?(?:bigger|larger))\b`, " _increase "],
    [String.raw`\b(?:shoot(?:s|ing)? past|zig[- ]?zag\w*|jump(?:s|ing)? around|goes? crazy)\b`, " _diverge "],
    [String.raw`\b(?:many (?:iterations|steps|epochs)|lots of (?:iterations|steps|epochs)|dheere|dheema|dheemi)\b`, " _slow "],
    [String.raw`\b(?:negative log[- ]likelihood|nll)\b`, " _ce "],
    [String.raw`\b(?:hidden (?:values|states|outputs)|intermediate activations)\b`, " _activation "],
    [String.raw`\b(?:keep(?:s|ing)? (?:them |it )?in memory|hold(?:s|ing)? on to)\b`, " _store "],
    [String.raw`\b(?:right to left|back to front|end to (?:the )?start)\b`, " _backward "],
    [String.raw`\b(?:naye data|naya data|unseen examples|real[- ]world data|holdout|hold[- ]out)\b`, " _test _data "],
    [String.raw`\b(?:too (?:big|large|huge) (?:a )?model|huge model|very deep|high[- ]degree|bahut complex)\b`, " _complex "],
    [String.raw`\b(?:too small (?:a )?model|tiny model|linear model|low[- ]degree)\b`, " _simple "],
    [String.raw`\b(\w+)'s\b`, " $1 "],
  ] as [string, string][]
).map(([p, r]) => [new RegExp(p, "g"), r]);

const SYN_LIST: [string, string][] = [
  ["_param", "weight weights parameter parameters param params theta coefficient coefficients"],
  ["_update", "jump jumps leap leaps stride strides"],
  ["_decrease", "ghatate ghataate ghatati"],
  ["_measure _control", "bataata bataati bataate"],
  ["_diff", "alag"],
  ["_update", "correct corrects tune tunes adjusted updated nudged"],
  ["_diverge", "unstable instability overshot"],
  ["_slow", "sluggish slowwww"],
  ["_increase", "badhana badhta badhti increases increasing increased"],
  ["_decrease", "ghatana ghatta ghatti decreasing decreased reduced reducing shrink shrinks"],
  ["_learn", "sikhna sikhta seekhta memorization overlearn"],
  ["_compute", "work figure"],
  ["_true", "sahi"],
  ["_measure", "evaluate evaluates quantif"],
  ["_test", "evaluation"],
  ["_whole", "complete"],
  ["_loss", "loss losses error errors cost costs"],
  ["_grad", "gradient gradients slope slopes grad derivative derivatives differentiate differentiation partial contribute contributed contributes contribution responsible blame"],
  ["_update", "update updates updating step steps move moves moving change changes adjust adjusts nudge nudges shift shifts tweak tweaks modify"],
  ["_size", "size sizes"],
  ["_control", "control controls decide decides determine determines govern governs"],
  ["_measure _control", "batata batati batate"],
  ["_diverge", "overshoot overshoots overshooting diverge diverges divergence explode explodes oscillate oscillates unstable bounce bounces"],
  ["_converge", "converge converges convergence settle settles"],
  ["_slow", "slow slowly slower crawl crawls forever"],
  ["_fast", "fast quickly quick faster jaldi"],
  ["_large", "large big high huge giant higher bigger larger greater zyada jyada jada bada badi bade bara more"],
  ["_small", "small low tiny little smaller lower chhota chota choti chhoti kam few fewer less lesser"],
  ["_increase", "increase increases rise rises raise grow grows worse worsen worsens maximize maximise maximizes maximises maximum max badhata"],
  ["_decrease", "decrease decreases reduce reduces reduction lowers lowering minimize minimise minimizes minimises minimizing minimising prevent prevents fix fixes avoid avoids combat curb help helps rok rokna rokne ghata ghatana"],
  ["_minimum", "minimum minima lowest bottom"],
  ["_batch", "batch batches minibatch sample samples subset"],
  ["_whole", "entire whole full poora pura"],
  ["_data", "data dataset datasets"],
  ["_estimate", "estimate estimates approximate approximates approximation"],
  ["_forward", "forward forwards aage"],
  ["_backward", "backward backwards back reverse peeche piche pichhe"],
  ["_input", "input inputs"],
  ["_output", "output outputs"],
  ["_store", "store stores storing save saves saving remember remembers cache caches record records yaad stored saved cached"],
  ["_mul", "multiply multiplies multiplied multiplying multiplication product products times guna * · ×"],
  ["_add", "add adds added adding sum sums plus addition jod jodte +"],
  ["_noise", "noise noisy quirks fluctuations"],
  ["_learn", "learn learns learning learned learnt fit fits fitting memorize memorise memorizes memorises memorizing capture captures seekh seekhta seekhna"],
  ["_general", "general generalize generalise generalizes generalises generalization"],
  ["_pattern", "pattern patterns trend trends signal"],
  ["_train", "train training trained"],
  ["_test", "test testing validation val unseen"],
  ["_good", "good well accurate accha achha acha great better perfect perfectly"],
  ["_bad", "bad badly poor poorly terrible kharab bura"],
  ["_complex", "complex complicated deep flexible"],
  ["_simple", "simple simpler shallow"],
  ["_reg", "regularization regularisation regularize regularise dropout penalty l2 l1 decay"],
  ["_overfit", "overfitting overfit overfits overfitted"],
  ["_regress", "regression regress"],
  ["_classif", "classification classify classifier classes category categories"],
  ["_aim", "want wants try tries"],
  ["_part", "part parts piece pieces"],
  ["_good", "perform performs"],
  ["_measure", "measure measures measuring quantify quantifies tell tells score scores indicate indicates"],
  ["_pred", "prediction predictions predict predicts predicted guess guesses"],
  ["_true", "true actual real target targets label labels truth asli correct"],
  ["_diff", "far gap difference distance door deviation"],
  ["_aim", "aim aims goal goals purpose objective"],
  ["_acc", "accuracy"],
  ["_composite", "composite nested"],
  ["_inner", "inner andar"],
  ["_outer", "outer bahar"],
  ["_every", "every each all har sab saare sare"],
  ["_before", "first pehle before initially"],
  ["_after", "after baad later finally afterwards"],
  ["_compute", "compute computes computed computing calculate calculates calculated find finds found nikal get gets obtain obtains give gives mil milta milti"],
  ["_gd", "optimizer optimiser optimization optimisation"],
  ["_local", "local"],
  ["_pass", "pass passes"],
  ["layer", "layer layers"],
  ["function", "function functions"],
];
const PREFIX: [string, string][] = [
  ["regulari", "_reg"], ["memori", "_learn"], ["minimi", "_decrease"], ["maximi", "_increase"], ["overfit", "_overfit"],
  ["generali", "_general"], ["differentia", "_grad"], ["classif", "_classif"], ["optimi", "_gd"], ["converg", "_converge"],
  ["diverg", "_diverge"], ["backprop", "_backprop"],
];

export const ANT: Record<string, string> = {};
for (const [a, b] of [
  ["_large", "_small"], ["_increase", "_decrease"], ["_forward", "_backward"], ["_input", "_output"], ["_opposite", "_same"],
  ["_fast", "_slow"], ["_batch", "_whole"], ["_mul", "_add"], ["_good", "_bad"], ["_complex", "_simple"],
  ["_early_stop", "_longer"], ["_regress", "_classif"], ["_before", "_after"], ["_converge", "_diverge"], ["_train", "_test"],
]) {
  ANT[a] = b;
  ANT[b] = a;
}
// Gradable polarity words where "not X" means the opposite of X ("not small" = large). Nominal pairs
// (forward/backward, input/output, regression/classification...) are kept as negated tokens instead.
const INVERTIBLE = new Set(["_large", "_small", "_good", "_bad", "_fast", "_slow", "_increase", "_decrease", "_complex", "_simple", "_same", "_opposite", "_converge", "_diverge"]);
const DIRECTIONAL: [string, string][] = [["_input", "_output"], ["_before", "_after"]];
const GENERIC = new Set(["_every", "layer", "function", "_compute", "_nn", "_data", "_pass", "_minimum", "_before", "_after"]);

export function stem(w: string): string {
  if (w.length <= 3 || w.startsWith("_") || /\d/.test(w)) return w;
  let s = w;
  if (s.endsWith("ies") && s.length > 4) s = s.slice(0, -3) + "y";
  else if (s.endsWith("sses")) s = s.slice(0, -2);
  else if (/(?:ss|x|z|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith("s") && !/(?:ss|us|is)$/.test(s)) s = s.slice(0, -1);
  if (s.endsWith("ing") && s.length > 5) s = s.slice(0, -3);
  else if (s.endsWith("ed") && s.length > 4) s = s.slice(0, -2);
  if (/([^lsz])\1$/.test(s)) s = s.slice(0, -1);
  if (s.endsWith("ly") && s.length > 4) s = s.slice(0, -2);
  if (s.endsWith("e") && s.length > 4) s = s.slice(0, -1);
  return s;
}

const SYN_SURFACE = new Map<string, string[]>();
const SYN_STEM = new Map<string, string[]>();
for (const [canon, words] of SYN_LIST) {
  const toks = canon.split(" ");
  for (const w of words.split(/\s+/)) {
    if (!SYN_SURFACE.has(w)) SYN_SURFACE.set(w, toks);
    const s = stem(w);
    if (!SYN_STEM.has(s)) SYN_STEM.set(s, toks);
  }
}

function canon(w: string): string[] {
  if (w.startsWith("_")) return [w];
  const sur = SYN_SURFACE.get(w);
  if (sur) return sur;
  if (STOP.has(w)) return [];
  const s = stem(w);
  const st = SYN_STEM.get(s);
  if (st) return st;
  for (const [p, c] of PREFIX) if (w.startsWith(p)) return [c];
  if (w.length === 1 && !/[xyfgz0-9]/.test(w)) return [];
  return [s];
}

export interface Tok { t: string; or?: boolean }
interface Tokenized { toks: Tok[]; hasNeg: boolean; negated: Set<string>; hasAbs: boolean; restricted: Set<string> }

/** Derivative terms of a formula, e.g. "f'(g(x))" and "g'(x)", normalised (spaces removed). */
export function formulaTerms(text: string): Set<string> {
  const s = text.toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, "");
  return new Set(s.match(/[a-z]'\((?:[^()]|\([^()]*\))*\)/g) ?? []);
}

function normalize(text: string): string {
  let s = " " + text.toLowerCase().replace(/[’‘`]/g, "'").replace(/[“”]/g, '"').replace(/\b(?:not|non)-(\w)/g, "non$1").replace(/([a-z0-9])_(?=[a-z0-9])/g, "$1 ") + " ";
  for (const [re, rep] of PHRASES) s = s.replace(re, rep);
  return s.replace(/[,;:!?]|\.(?=\s|$)|\b(?:toh|then)\b/g, " _brk ");
}

export function tokenize(text: string): Tokenized {
  const raw = normalize(text).match(/[a-z0-9_]+|[*·×+]/g) ?? [];
  const out: { t: string; neg: boolean; or?: boolean; brk?: boolean }[] = [];
  let pending = 0;
  let hasNeg = false;
  let absPending = 0;
  let hasAbs = false;
  const restricted = new Set<string>();
  for (const w of raw) {
    if (w === "_brk") {
      pending = 0;
      absPending = 0;
      out.push({ t: "_brk", neg: false, brk: true });
      continue;
    }
    if (w === "_abs") {
      absPending = 2;
      hasAbs = true;
      continue;
    }
    if (w === "_not") {
      pending = 2;
      hasNeg = true;
      continue;
    }
    if (w === "_npost") {
      hasNeg = true;
      for (let k = out.length - 1; k >= 0 && k >= out.length - 2; k--) {
        if (out[k].brk) break;
        if (out[k].or || GENERIC.has(out[k].t)) continue;
        out[k].neg = true;
        break;
      }
      continue;
    }
    if (w === "or" || w === "ya") {
      out.push({ t: "_or", neg: false, or: true });
      continue;
    }
    const cs = canon(w);
    for (const c of cs) out.push({ t: c, neg: pending > 0 });
    if (cs.length && pending > 0) pending--;
    if (cs.length && absPending > 0) {
      for (const c of cs) if (c.startsWith("_") && !GENERIC.has(c)) restricted.add(c);
      absPending--;
    }
  }
  // Compose size words with loss/accuracy into performance polarity ("low training error" -> good).
  const idx = out.map((o, i) => (o.or ? -1 : i)).filter((i) => i >= 0);
  for (let a = 0; a < idx.length; a++) {
    const o = out[idx[a]];
    if (o.t !== "_small" && o.t !== "_large") continue;
    for (let b = Math.max(0, a - 2); b <= Math.min(idx.length - 1, a + 2); b++) {
      // never compose across a clause boundary
      const lo = Math.min(a, b), hi = Math.max(a, b);
      if (idx.slice(lo, hi + 1).some((k) => out[k].brk)) continue;
      const n = out[idx[b]].t;
      if (n === "_loss") {
        o.t = o.t === "_small" ? "_good" : "_bad";
        break;
      }
      if (n === "_acc") {
        o.t = o.t === "_small" ? "_bad" : "_good";
        break;
      }
    }
  }
  const negated = new Set<string>();
  const toks: Tok[] = out.filter((o) => !o.brk).map((o) => {
    if (o.neg && INVERTIBLE.has(o.t)) return { t: ANT[o.t] };
    if (o.neg) negated.add(o.t);
    return o.or ? { t: o.t, or: true } : { t: o.t };
  });
  // Talking about an inner and an outer function is talking about a composite function.
  if (toks.some((x) => x.t === "_inner") && toks.some((x) => x.t === "_outer") && !toks.some((x) => x.t === "_composite")) toks.push({ t: "_composite" });
  return { toks, hasNeg, negated, hasAbs, restricted };
}

const agnKey = (t: string) => (ANT[t] ? "~" + [t, ANT[t]].sort().join("|") : t);
const content = (toks: Tok[]) => toks.filter((x) => !x.or).map((x) => x.t);

interface Span { start: number; end: number; text: string }

function trimSpan(text: string, start: number, end: number): Span | null {
  while (start < end && /[\s,;:\-–—]/.test(text[start])) start++;
  while (end > start && /[\s,;:\-–—]/.test(text[end - 1])) end--;
  return end > start ? { start, end, text: text.slice(start, end) } : null;
}

export function splitSentences(text: string): Span[] {
  const out: Span[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const isEnd =
      ch === "\n" ||
      ((ch === "." || ch === "!" || ch === "?" || ch === "।") && (i + 1 >= text.length || /\s/.test(text[i + 1])) && !(ch === "." && /\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "")));
    if (isEnd) {
      const s = trimSpan(text, start, i + 1);
      if (s) out.push(s);
      start = i + 1;
    }
  }
  const s = trimSpan(text, start, text.length);
  if (s) out.push(s);
  return out;
}

const CLAUSE_RE = /[,;:]\s*|\s+(?:and|but|while|whereas|so|because|aur|par|lekin|magar|kyunki|toh|though|however)\s+|\s+[-–—]+\s+/gi;
function splitClauses(text: string, sent: Span): Span[] {
  const pieces: Span[] = [];
  let last = 0;
  CLAUSE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLAUSE_RE.exec(sent.text))) {
    const s = trimSpan(text, sent.start + last, sent.start + m.index);
    if (s) pieces.push(s);
    last = m.index + m[0].length;
  }
  const s = trimSpan(text, sent.start + last, sent.end);
  if (s) pieces.push(s);
  // Merge tiny fragments (< 2 content tokens) into the previous piece.
  const merged: Span[] = [];
  for (const p of pieces) {
    const n = content(tokenize(p.text).toks).length;
    if (merged.length && n < 2) {
      const prev = merged[merged.length - 1];
      merged[merged.length - 1] = { start: prev.start, end: p.end, text: text.slice(prev.start, p.end) };
    } else merged.push(p);
  }
  if (merged.length > 1 && content(tokenize(merged[0].text).toks).length < 2) {
    const [a, b] = merged;
    merged.splice(0, 2, { start: a.start, end: b.end, text: text.slice(a.start, b.end) });
  }
  return merged;
}

interface Model {
  id: string;
  text: string;
  page: number | null;
  toks: string[];
  set: Set<string>;
  variants: string[][];
  cores: string[][];
  bigrams: Set<string>;
  clauses: Set<string>[];
  hasNeg: boolean;
  nums: Set<string>;
  fterms: Set<string>;
  hasAbs: boolean;
}

function buildModel(id: string, text: string, page: number | null): Model {
  const tk = tokenize(text);
  const toks = content(tk.toks);
  const set = new Set(toks);
  // "A or B" claims: either alternative is enough.
  const variants: string[][] = [[...set]];
  const cores: string[][] = [[]];
  tk.toks.forEach((x, i) => {
    if (!x.or) return;
    const before = content(tk.toks.slice(0, i)).slice(-3);
    const after = content(tk.toks.slice(i + 1)).slice(0, 1);
    const drop = (d: string[]) => [...set].filter((t) => !d.includes(t) || before.concat(after).filter((z) => z === t).length > 1);
    variants.push(drop(after), drop(before));
    cores.push(before, after);
  });
  const bigrams = new Set<string>();
  for (let i = 0; i + 1 < toks.length; i++) bigrams.add(agnKey(toks[i]) + " " + agnKey(toks[i + 1]));
  const sent: Span = { start: 0, end: text.length, text };
  const clauses = splitClauses(text, sent).map((c) => new Set(content(tokenize(c.text).toks)));
  const nums = new Set(toks.filter((t) => /^\d/.test(t)));
  const keep = variants.map((v, i) => i).filter((i) => variants[i].length);
  return { id, text, page, toks, set, variants: keep.map((i) => variants[i]), cores: keep.map((i) => cores[i]), bigrams, clauses, hasNeg: tk.hasNeg, nums, fterms: formulaTerms(text), hasAbs: tk.hasAbs };
}

type Weights = (t: string) => number;

function makeWeights(models: Model[], topic: string): Weights {
  const df = new Map<string, number>();
  for (const m of models) for (const t of m.set) df.set(t, (df.get(t) ?? 0) + 1);
  const topicToks = new Set(content(tokenize(topic).toks));
  const N = models.length;
  return (t: string) => {
    let w = 1 + Math.log((N + 1) / ((df.get(t) ?? 0) + 0.5));
    if (topicToks.has(t)) w *= 0.35;
    if (GENERIC.has(t)) w *= 0.5;
    if (t.length === 1) w *= 0.5;
    return Math.max(0.15, w);
  };
}

interface Cand { span: Span; toks: Tok[]; order: string[]; set: Set<string>; agn: Set<string>; bigrams: Set<string>; clauses: Set<string>[]; negated: Set<string>; canFlip: boolean; nums: Set<string>; fterms: Set<string>; restricted: Set<string> }

function makeCand(text: string, span: Span, clauseSpans: Span[], canFlip: boolean): Cand {
  const tk = tokenize(span.text);
  const toks = content(tk.toks);
  const bigrams = new Set<string>();
  for (let i = 0; i + 1 < toks.length; i++) {
    bigrams.add(agnKey(toks[i]) + " " + agnKey(toks[i + 1]));
    if (i + 2 < toks.length) bigrams.add(agnKey(toks[i]) + " " + agnKey(toks[i + 2]));
  }
  return {
    span,
    toks: tk.toks,
    order: toks,
    set: new Set(toks),
    agn: new Set(toks.map(agnKey)),
    bigrams,
    clauses: clauseSpans.map((c) => new Set(content(tokenize(c.text).toks))),
    negated: tk.negated,
    canFlip,
    nums: new Set(toks.filter((t) => /^\d/.test(t))),
    fterms: formulaTerms(span.text),
    restricted: tk.restricted,
  };
}

function similarity(m: Model, c: Cand, w: Weights): { strict: number; agn: number } {
  const best = { strict: 0, agn: 0 };
  const hasS = (t: string) => c.set.has(t);
  const hasA = (t: string) => c.agn.has(agnKey(t));
  m.variants.forEach((v, vi) => {
    let tot = 0, s = 0, a = 0;
    for (const t of v) {
      const wt = w(t);
      tot += wt;
      if (hasS(t)) s += wt;
      if (hasA(t)) a += wt;
    }
    if (!tot) return;
    // An "A or B" alternative counts only if its own words are mostly there.
    const core = m.cores[vi];
    if (core.length) {
      const cw = core.reduce((n, t) => n + w(t), 0);
      if (core.filter(hasS).reduce((n, t) => n + w(t), 0) < cw / 2) s = Math.min(s, tot * 0.45);
      if (core.filter(hasA).reduce((n, t) => n + w(t), 0) < cw / 2) a = Math.min(a, tot * 0.45);
    }
    if (s / tot > best.strict) best.strict = s / tot;
    if (a / tot > best.agn) best.agn = a / tot;
  });
  let hits = 0;
  for (const b of m.bigrams) if (c.bigrams.has(b)) hits++;
  const bonus = Math.min(0.12, 0.04 * hits);
  const strict = Math.min(1, best.strict + (best.strict > 0.25 ? bonus : 0));
  const agn = Math.min(1, best.agn + (best.agn > 0.25 ? bonus : 0));
  return { strict, agn };
}

/** Does candidate contradict the claim? Returns a reason or null. */
function contradiction(m: Model, c: Cand, w: Weights, lenient = false): string | null {
  if (m.nums.size && c.nums.size && ![...m.nums].some((n) => c.nums.has(n))) return "numbers";
  // Formula shape: the student's derivative terms differ from the notes' (f'(x)·g'(x) vs f'(g(x))·g'(x)).
  if (m.fterms.size && c.fterms.size && [...c.fterms].some((t) => !m.fterms.has(t))) return "formula";
  // Pass 1: gradable polarity (large/small, good/bad...) bound to role words (training/validation...) used as anchors.
  // Pass 2: every paired word (including roles) must not be swapped for its partner.
  const passes: { ci: number; pol: string[] }[] = [];
  m.clauses.forEach((cc, ci) => {
    const all = [...cc].filter((t) => ANT[t]);
    const gradable = all.filter((t) => INVERTIBLE.has(t));
    if (gradable.length) passes.push({ ci, pol: gradable });
    // In multi-clause claims, roles next to a gradable word are anchors only (pass 1 checks them).
    if (all.length > gradable.length && !(gradable.length && m.clauses.length > 1)) passes.push({ ci, pol: all });
  });
  for (const { ci, pol } of passes) {
    const cc = m.clauses[ci];
    const others = new Set<string>();
    m.clauses.forEach((o, j) => j !== ci && o.forEach((t) => others.add(t)));
    const anchors = [...cc].filter((t) => !pol.includes(t));
    const groups = new Set(pol.map(agnKey));
    const own = anchors.filter((t) => !others.has(t) && !GENERIC.has(t));
    let best: Set<string> | null = null;
    let bestScore = 0;
    for (const sc of c.clauses) {
      if (![...sc].some((t) => groups.has(agnKey(t)))) continue;
      if (own.length && m.clauses.length > 1 && !own.some((t) => sc.has(t))) continue;
      let s = 0;
      for (const t of anchors) if (sc.has(t)) s += w(t) * (others.has(t) ? 1 : 2);
      for (const t of m.set) if (!ANT[t] && sc.has(t)) s += w(t) * 0.5;
      if (s > bestScore) {
        bestScore = s;
        best = sc;
      }
    }
    if (!best && m.clauses.length === 1) best = c.set;
    if (!best) continue;
    for (const p of pol) {
      const a = ANT[p];
      if (cc.has(a)) continue;
      if (best.has(a) && !best.has(p)) return `${p}->${a}`;
    }
  }
  // Direction swap: the claim goes "from A to B", the student goes from B to A.
  for (const [p, a] of DIRECTIONAL) {
    const ip = m.toks.indexOf(p), ia = m.toks.indexOf(a), jp = c.order.indexOf(p), ja = c.order.indexOf(a);
    if (ip >= 0 && ia >= 0 && jp >= 0 && ja >= 0 && ip < ia !== jp < ja) return `order ${p}/${a}`;
  }
  if (!m.hasNeg && !lenient) {
    for (const t of c.negated) if (m.set.has(t) && !GENERIC.has(t) && w(t) >= 1.2) return `not ${t}`;
  }
  // Absolute qualifier ("only in the forward pass", "always better") restricting the idea to something the claim doesn't say.
  if (!m.hasAbs && !lenient) {
    for (const t of c.restricted) if (!m.set.has(t) && !m.set.has(ANT[t] ?? "") && t !== "_every") return `only ${t}`;
  }
  return null;
}

/** Calibrated on the eval dev split only (eval/run.ts --sweep). */
export const TUNING = { covered: 0.5, wrong: 0.5, wrongDirect: 0.3, windowPenalty: 0.88 };

interface Verdict { status: ClaimStatus; evidence: string; span: Span | null; strict: number; agn: number }

function judge(m: Model, cands: Cand[], w: Weights, appeal: boolean, siblings: Model[]): Verdict {
  const TC = TUNING.covered, TW = TUNING.wrong;
  const tc = appeal ? TC * 0.65 : TC;
  let bestWrong: { c: Cand; s: number } | null = null;
  const scored = cands.map((c) => {
    const sim = similarity(m, c, w);
    return c.canFlip ? { c, ...sim } : { c, strict: sim.strict * TUNING.windowPenalty, agn: sim.agn * TUNING.windowPenalty };
  });
  // A span that correctly states a sibling claim (e.g. the large-learning-rate case) doesn't contradict this one.
  const explainedBySibling = (c: Cand, strict: number) =>
    siblings.some((o) => {
      if (o === m) return false;
      const sim = similarity(o, c, w);
      return sim.strict >= TUNING.covered && sim.strict > strict && !contradiction(o, c, w);
    });
  const flips = new Set<Cand>();
  const mismatched = new Set<Cand>();
  let formulaWrong = false;
  for (const x of scored) {
    if (!x.c.canFlip || x.agn < Math.min(TW, TUNING.wrongDirect)) continue;
    const why = contradiction(m, x.c, w, appeal);
    if (why) mismatched.add(x.c);
    // Direct denials ("not X", a different formula) of the claim's own concept need less surrounding overlap.
    const need = why && /^(?:not|formula)/.test(why) ? TUNING.wrongDirect : TW;
    if (!why || x.agn < need || explainedBySibling(x.c, x.strict)) continue;
    flips.add(x.c);
    if (why === "formula") formulaWrong = true;
    if (!bestWrong || x.agn > bestWrong.s) bestWrong = { c: x.c, s: x.agn };
  }
  // Coverage may not come from a span that contains the contradicting statement.
  const bw = bestWrong;
  const overlapsWrong = (c: Cand) => !!bw && c.span.start < bw.c.span.end && bw.c.span.start < c.span.end;
  const containsMismatch = (c: Cand) => [...mismatched].some((o) => c.span.start <= o.span.start && o.span.end <= c.span.end);
  let bestCov: { c: Cand; s: number } | null = null;
  for (const x of scored) {
    if (containsMismatch(x.c) || overlapsWrong(x.c)) continue;
    if (!bestCov || x.strict > bestCov.s) bestCov = { c: x.c, s: x.strict };
  }
  const pickShortest = (pred: (x: (typeof scored)[number]) => boolean) =>
    scored.filter(pred).sort((a, b) => a.c.span.text.length - b.c.span.text.length)[0]?.c ?? null;
  if (bestWrong && bestWrong.s >= Math.min(TW, TUNING.wrongDirect) && (formulaWrong || !bestCov || bestCov.s < tc || bestWrong.s >= bestCov.s + 0.05)) {
    const s = bestWrong.s;
    const c = pickShortest((x) => x.agn >= s - 0.05 && flips.has(x.c)) ?? bestWrong.c;
    return { status: "wrong", evidence: c.span.text, span: c.span, strict: 0, agn: s };
  }
  if (bestCov && bestCov.s >= tc) {
    const s = bestCov.s;
    const c = pickShortest((x) => x.strict >= s - 0.05 && !containsMismatch(x.c) && !overlapsWrong(x.c)) ?? bestCov.c;
    return { status: "covered", evidence: c.span.text, span: c.span, strict: s, agn: s };
  }
  return { status: "missing", evidence: "", span: null, strict: bestCov?.s ?? 0, agn: 0 };
}

const PRONOUN = /\b(?:it|this|ye|yeh|isko|isse|iska)\b/i;

const lcFirst = (s: string) => (s && !/^[A-Z]{2}/.test(s) ? s[0].toLowerCase() + s.slice(1) : s).replace(/\.$/, "");

/** Built-in grading engine (runs with no API key). */
export function builtinGrade(input: GradeInput): GradeResult {
  const text = input.explanation;
  const allModels = input.claims.map((c) => buildModel(c.id, c.text, c.page));
  const w = makeWeights(allModels, input.topic);
  const only = new Set(input.only?.length ? input.only : input.claims.map((c) => c.id));

  const sents = splitSentences(text);
  const sentClauses = sents.map((s) => splitClauses(text, s));
  const cands: Cand[] = [];
  sents.forEach((s, i) => {
    const cl = sentClauses[i];
    cands.push(makeCand(text, s, cl, true));
    if (cl.length > 1) {
      cl.forEach((c, j) => {
        cands.push(makeCand(text, c, [c], true));
        if (j + 1 < cl.length) {
          const sp = { start: c.start, end: cl[j + 1].end, text: text.slice(c.start, cl[j + 1].end) };
          cands.push(makeCand(text, sp, [c, cl[j + 1]], true));
        }
      });
    }
    if (i + 1 < sents.length) {
      const sp = { start: s.start, end: sents[i + 1].end, text: text.slice(s.start, sents[i + 1].end) };
      cands.push(makeCand(text, sp, [...cl, ...sentClauses[i + 1]], false));
    }
  });
  // "it / this / ye" stands for the topic being explained ("if you set it too large").
  const topicToks = content(tokenize(input.topic).toks).filter((t) => !GENERIC.has(t));
  for (const c of cands) {
    if (!topicToks.length || topicToks.some((t) => c.set.has(t)) || !PRONOUN.test(c.span.text)) continue;
    // Only for binding contradictions to their subject; similarity scores are unchanged.
    for (const t of topicToks) c.clauses.forEach((cl) => cl.add(t));
  }

  const claims: ClaimGrade[] = [];
  const used: Span[] = [];
  for (const m of allModels) {
    if (!only.has(m.id)) continue;
    const v = cands.length ? judge(m, cands, w, input.appeal?.claimId === m.id, allModels) : { status: "missing" as const, evidence: "", span: null };
    if (v.span) used.push(v.span);
    claims.push({ claim_id: m.id, status: v.status, evidence: v.evidence, correction: v.status === "wrong" ? m.text : "", page: m.page });
  }

  // Misconceptions: sentences that contradict a note sentence or claim but were not used as evidence.
  const pool: Model[] = [...allModels];
  for (const ch of input.chunks) for (const s of splitSentences(ch.text)) if (s.text.length > 20) pool.push(buildModel("", s.text, ch.page));
  const pw = makeWeights(pool, input.topic);
  const overlaps = (s: Span) => used.some((u) => u.start < s.end && s.start < u.end);
  const misconceptions: Misconception[] = [];
  const notInNotes: string[] = [];
  const vocab = new Set<string>();
  for (const m of pool) m.set.forEach((t) => vocab.add(t));
  content(tokenize(input.topic).toks).forEach((t) => vocab.add(t));
  sents.forEach((s, i) => {
    if (overlaps(s)) return;
    const c = makeCand(text, s, sentClauses[i], true);
    let hit: { m: Model; s: number } | null = null;
    for (const m of pool) {
      const sim = similarity(m, c, pw);
      if (sim.agn >= 0.55 && contradiction(m, c, pw) && (!hit || sim.agn > hit.s)) hit = { m, s: sim.agn };
    }
    if (hit) {
      misconceptions.push({ quote: s.text, correction: hit.m.text.trim(), page: hit.m.page });
      return;
    }
    const toks = [...c.set].filter((t) => !GENERIC.has(t) && !/^\d/.test(t) && t.length > 1);
    if (toks.length >= 4) {
      const known = toks.filter((t) => vocab.has(t)).length / toks.length;
      if (known < (input.chunks.length ? 0.34 : 0.2)) notInNotes.push(s.text);
    }
  });

  const strengths = claims
    .filter((c) => c.status === "covered")
    .slice(0, 3)
    .map((c) => `You explained clearly that ${lcFirst(allModels.find((m) => m.id === c.claim_id)!.text)}.`);

  const raw: GradeResponse = { claims: claims.map((c) => ({ ...c })), misconceptions: misconceptions.slice(0, 3), strengths, not_in_notes: notInNotes.slice(0, 3) };
  return finalizeResult(raw, input);
}
