// Question banks and answer grading for Viva (claims) and Placement (repo). AI first, local heuristics as fallback.
import "server-only";
import { z } from "zod";
import { all, newId } from "@/lib/db";
import { hasAI, aiJSON } from "@/lib/ai";
import type { Citation, Level, Persona, RepoSummary, VivaQuestion, Verdict } from "./types";
import { bestSnippet, clamp01, contradicts, coverage, keywords, shorten, wordCount } from "./text";

export class VivaError extends Error {}

export interface ClaimRow { id: string; topic_id: string; topic_name: string; text: string; source_id: string | null; page: number | null; file_name: string | null }

export async function loadClaims(subjectId: string): Promise<ClaimRow[]> {
  return all<ClaimRow>(
    `SELECT c.id, c.topic_id, t.name AS topic_name, c.text, c.source_id, c.page, s.file_name
     FROM claims c JOIN topics t ON t.id = c.topic_id LEFT JOIN sources s ON s.id = c.source_id
     WHERE t.subject_id = ? ORDER BY t.position, t.name, c.position`,
    subjectId,
  );
}

export async function claimsById(ids: string[]): Promise<ClaimRow[]> {
  if (!ids.length) return [];
  return all<ClaimRow>(
    `SELECT c.id, c.topic_id, t.name AS topic_name, c.text, c.source_id, c.page, s.file_name
     FROM claims c JOIN topics t ON t.id = c.topic_id LEFT JOIN sources s ON s.id = c.source_id
     WHERE c.id IN (${ids.map(() => "?").join(",")})`,
    ...ids,
  );
}

export function citationFor(c: ClaimRow): Citation | null {
  if (!c.source_id) return null;
  const page = c.page ?? 1;
  return { label: `${c.file_name ?? "Notes"}, p.${page}`, href: `/sources/${c.source_id}?page=${page}` };
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const PERSONA_STYLE: Record<Persona, string> = {
  friendly: "a friendly senior student: warm, encouraging, casual, gives small hints",
  strict: "a strict university professor: formal, precise, terse, no praise unless earned",
  fast: "a fast-paced technical interviewer: very short sentences, rapid fire",
};

// ---------- Viva question bank ----------

function groupTopics(claims: ClaimRow[]) {
  const m = new Map<string, { id: string; name: string; claims: ClaimRow[] }>();
  for (const c of claims) {
    if (!m.has(c.topic_id)) m.set(c.topic_id, { id: c.topic_id, name: c.topic_name, claims: [] });
    m.get(c.topic_id)!.claims.push(c);
  }
  return [...m.values()];
}

function templateVivaBank(claims: ClaimRow[], maxTopics: number): VivaQuestion[] {
  const out: VivaQuestion[] = [];
  for (const t of shuffle(groupTopics(claims)).slice(0, maxTopics)) {
    const cs = t.claims;
    const first = cs.slice(0, Math.min(2, cs.length));
    const mid = cs.length > 2 ? cs.slice(1, 3) : cs;
    const last = cs.length > 1 ? cs.slice(-2) : cs;
    const kMid = keywords(mid.map((c) => c.text).join(" "), t.name, 2);
    const kLast = keywords(last.map((c) => c.text).join(" "), t.name, 1)[0];
    const base = { topicId: t.id, topicName: t.name };
    out.push({ ...base, id: newId("q_"), level: 1, kind: "definition", claimIds: first.map((c) => c.id), text: Math.random() < 0.5 ? `What is ${t.name}? Define it in your own words.` : `In two or three sentences, what does ${t.name} mean?` });
    out.push({
      ...base, id: newId("q_"), level: 2, kind: "mechanism", claimIds: mid.map((c) => c.id),
      text: kMid.length ? `How does ${t.name} actually work? Walk me through it, and tell me where ${kMid.join(" and ")} fit in.` : `How does ${t.name} actually work? Walk me through it step by step.`,
    });
    out.push({
      ...base, id: newId("q_"), level: 3, kind: "application", claimIds: last.map((c) => c.id),
      text: kLast ? (Math.random() < 0.5 ? `Where would ${t.name} fail or break down? Think about ${kLast}.` : `Give me a real use of ${t.name}, and tell me what happens if ${kLast} goes wrong.`) : `Give me a real application of ${t.name}, and one edge case where it breaks.`,
    });
  }
  return out;
}

const VivaBankSchema = z.object({
  questions: z.array(z.object({ text: z.string().min(5), level: z.number().int().min(1).max(3), kind: z.string(), topic_id: z.string(), claim_ids: z.array(z.string()).min(1) })).min(3),
});

export async function buildVivaBank(subjectId: string, durationMin: number): Promise<VivaQuestion[]> {
  const claims = await loadClaims(subjectId);
  if (!claims.length) throw new VivaError("This subject has no topics or claims yet. Upload your notes first, then start a viva.");
  const maxTopics = Math.max(4, Math.min(12, durationMin + 2));
  if (!hasAI()) return templateVivaBank(claims, maxTopics);
  const topics = shuffle(groupTopics(claims)).slice(0, maxTopics);
  const byId = new Map(claims.map((c) => [c.id, c]));
  try {
    const res = await aiJSON(
      {
        model: "strong",
        maxTokens: 3000,
        system:
          "You are an oral examiner preparing a viva from a student's own notes. For each topic write 3 questions: level 1 = definition, level 2 = mechanism (how/why it works), level 3 = application or edge case (where it fails, what happens if...). Each question must be answerable from the listed claims only and must NOT reveal the answer. Questions are short, spoken aloud (max 30 words). Reference claim ids exactly.",
        user: `Topics and claims:\n${topics.map((t) => `TOPIC ${t.id}: ${t.name}\n${t.claims.map((c) => `  - [${c.id}] ${c.text}`).join("\n")}`).join("\n")}\n\nReturn {"questions":[{"text","level":1|2|3,"kind":"definition|mechanism|application|edge_case","topic_id","claim_ids":[...]}]}`,
      },
      VivaBankSchema,
    );
    const qs: VivaQuestion[] = [];
    for (const q of res.questions) {
      const ids = q.claim_ids.filter((id) => byId.has(id));
      if (!ids.length) continue;
      const topic = byId.get(ids[0])!;
      qs.push({ id: newId("q_"), text: q.text.trim(), level: q.level as Level, kind: q.kind, topicId: topic.topic_id, topicName: topic.topic_name, claimIds: ids });
    }
    return qs.length >= 3 ? qs : templateVivaBank(claims, maxTopics);
  } catch (e) {
    console.warn("[viva] AI bank failed, using templates", e);
    return templateVivaBank(claims, maxTopics);
  }
}

// ---------- Placement question bank ----------

const TRADEOFF = /\b(because|trade-?offs?|instead|rather than|however|but|alternative|chose|choose|decided|downside|cost|latency|throughput|scal\w*|cach\w*|index\w*|simpl\w*|faster|slower|memory|bottleneck|consisten\w*|reliab\w*|maintain\w*|complexity|overhead|benchmark\w*|so that|in order to|which means|otherwise)\b/gi;

export function templatePlacementBank(r: RepoSummary): VivaQuestion[] {
  const qs: VivaQuestion[] = [];
  const add = (level: Level, kind: string, text: string, expected: string[]) => qs.push({ id: newId("q_"), level, kind, text, expected: expected.map((e) => e.toLowerCase()).filter(Boolean), claimIds: [], topicName: r.name });
  const stack = [...r.languages.slice(0, 2), ...r.deps.slice(0, 2)].filter(Boolean);
  const dep = r.deps.find((d) => !/^(typescript|eslint|prettier|nodemon|dotenv)$/i.test(d));
  const dep2 = r.deps.filter((d) => d !== dep).find((d) => !/^(typescript|eslint|prettier|nodemon|dotenv)$/i.test(d));
  const file = r.notableFiles[0];
  const file2 = r.notableFiles[1];
  const heading = r.readmeHeadings.find((h) => !/^(installation|install|setup|getting started|usage|requirements|prerequisites|license|demo|screenshots?)$/i.test(h) && h.toLowerCase() !== r.name.toLowerCase());

  add(1, "pitch", `Give me the 30-second pitch for ${r.name}. What problem does it solve, and who is it for?`, r.description ? keywords(r.description, "", 3) : []);
  if (stack.length) add(1, "stack", `Walk me through the stack of ${r.name}: ${stack.join(", ")}. What does each piece do?`, stack);
  if (heading) add(1, "readme", `Your README has a section called "${heading}". Explain that part as if I'm a new teammate.`, keywords(heading, "", 2));
  if (dep) add(2, "design", `Why did you pick ${dep}${dep2 ? ` and ${dep2}` : ""}? What did it buy you over the alternatives?`, [dep, ...(dep2 ? [dep2] : [])]);
  if (file) add(2, "code", `Take me through ${file}. What happens there, and how does it connect to the rest of the code?`, [file.split("/").pop()!.replace(/\.[a-z0-9]+$/i, ""), ...(r.topDirs.slice(0, 1))]);
  if (r.topDirs.length >= 2) add(2, "structure", `Why is the code split into ${r.topDirs.slice(0, 3).map((d) => `${d}/`).join(", ")}? What lives where, and why that boundary?`, r.topDirs.slice(0, 3));
  add(2, "dataflow", `Pick one request or user action in ${r.name} and trace it end to end${file2 ? `, including ${file2}` : ""}.`, [...(file2 ? [file2.split("/").pop()!.replace(/\.[a-z0-9]+$/i, "")] : []), ...r.topDirs.slice(0, 2)]);
  add(3, "tradeoff", `What's the biggest trade-off you made in ${r.name}? What did you give up, and was it worth it?`, ["trade-off", ...(dep ? [dep] : [])]);
  add(3, "scale", `If ${r.name} suddenly had 100 times more users or data, what breaks first${file ? `, and what would you change in ${file}` : ""}?`, ["scale", "bottleneck", ...(file ? [file.split("/").pop()!.replace(/\.[a-z0-9]+$/i, "")] : [])]);
  add(3, "testing", r.hasTests ? `How do you test ${r.name}? What isn't covered by your tests that worries you?` : `I don't see tests in ${r.name}. How do you know it works, and what would you test first?`, ["test"]);
  add(3, "change", `If you rebuilt ${r.name} from scratch today, what would you change and why?`, r.deps.slice(0, 2));
  add(3, "failure", `What happens in ${r.name} when ${dep ? `${dep} or an external service` : "an external service or the network"} fails? How do you handle errors?`, ["error", "retry", ...(dep ? [dep] : [])]);
  return qs;
}

const PlacementBankSchema = z.object({
  questions: z.array(z.object({ text: z.string().min(5), level: z.number().int().min(1).max(3), kind: z.string(), expected_terms: z.array(z.string()).default([]) })).min(5),
});

function repoBrief(r: RepoSummary): string {
  return [
    `Project: ${r.name}${r.url ? ` (${r.url})` : ""}`,
    `Description: ${r.description}`,
    r.languages.length ? `Languages: ${r.languages.join(", ")}` : "",
    r.deps.length ? `Dependencies: ${r.deps.join(", ")}` : "",
    r.topDirs.length ? `Top-level folders: ${r.topDirs.join(", ")}` : "",
    r.notableFiles.length ? `Notable files: ${r.notableFiles.join(", ")}` : "",
    r.readmeHeadings.length ? `README sections: ${r.readmeHeadings.join(" | ")}` : "",
    `Has tests: ${r.hasTests ? "yes" : "no"}`,
    r.pathsSample.length ? `File tree sample:\n${r.pathsSample.slice(0, 80).join("\n")}` : "",
    `README:\n${r.readmeExcerpt.slice(0, 5000)}`,
  ].filter(Boolean).join("\n");
}

export async function buildPlacementBank(r: RepoSummary): Promise<VivaQuestion[]> {
  const fallback = templatePlacementBank(r);
  if (!hasAI()) return fallback;
  try {
    const res = await aiJSON(
      {
        model: "strong",
        maxTokens: 2500,
        system:
          "You are a senior technical interviewer grilling a student on THEIR OWN project for a placement interview. Write 12 questions specific to this repository: design choices, trade-offs, what they'd change, how it scales, failure handling, testing, data flow. Reference real file names, folders, dependencies and README sections by name. No generic questions that would fit any project. Order easy (level 1: pitch/stack) to hard (level 3: trade-offs/scale/edge cases). Each question max 35 words, spoken aloud. expected_terms = 2-5 concrete repo terms or concepts a strong answer would mention.",
        user: `${repoBrief(r)}\n\nReturn {"questions":[{"text","level":1|2|3,"kind","expected_terms":[...]}]}`,
      },
      PlacementBankSchema,
    );
    const qs: VivaQuestion[] = res.questions.map((q) => ({ id: newId("q_"), text: q.text.trim(), level: q.level as Level, kind: q.kind, expected: q.expected_terms.map((t) => t.toLowerCase()), claimIds: [], topicName: r.name }));
    return qs.length >= 5 ? qs : fallback;
  } catch (e) {
    console.warn("[viva] AI placement bank failed, using templates", e);
    return fallback;
  }
}

// ---------- Grading ----------

export interface Graded {
  score: number;
  verdict: Verdict;
  strong: string[];
  missing: string[];
  /** Claim ids (viva) or expected terms (placement) that were missing — anchors for follow-ups. */
  missingKeys: string[];
  citations: Citation[];
  feedback: string | null;
  followUp: string | null;
  claimStatuses: { claimId: string; status: "covered" | "missing" | "wrong"; evidence: string; correction: string; page: number | null }[];
}

const SKIP = /^\s*(i don'?t know|no idea|pass|skip( it| this)?|next( question)?|not sure|idk|no answer)?\s*[.!]?\s*$/i;
export const isSkip = (text: string) => SKIP.test(text) || wordCount(text) === 0;

export function verdictOf(score: number): Verdict {
  return score >= 0.7 ? "strong" : score >= 0.35 ? "partial" : "weak";
}

function skipped(citations: Citation[], missing: string[], keys: string[]): Graded {
  return { score: 0, verdict: "skipped", strong: [], missing, missingKeys: keys, citations, feedback: null, followUp: null, claimStatuses: [] };
}

function gradeVivaLocal(q: VivaQuestion, claims: ClaimRow[], answer: string): Graded {
  const statuses: Graded["claimStatuses"] = [];
  const strong: string[] = [];
  const missing: string[] = [];
  const keys: string[] = [];
  let total = 0;
  for (const c of claims) {
    const cov = coverage(c.text, answer);
    const contra = contradicts(c.text, answer);
    if (contra) {
      statuses.push({ claimId: c.id, status: "wrong", evidence: contra, correction: c.text, page: c.page });
      missing.push(`You said "${shorten(contra, 70)}", but your notes say: ${c.text}`);
      keys.push(c.id);
    } else if (cov >= 0.5) {
      total += 1;
      statuses.push({ claimId: c.id, status: "covered", evidence: bestSnippet(c.text, answer), correction: "", page: c.page });
      strong.push(`"${bestSnippet(c.text, answer)}"`);
    } else {
      if (cov >= 0.3) total += 0.5;
      statuses.push({ claimId: c.id, status: "missing", evidence: "", correction: "", page: c.page });
      missing.push(c.text);
      keys.push(c.id);
    }
  }
  let score = claims.length ? total / claims.length : 0;
  if (wordCount(answer) < 6) score *= 0.6;
  const citations = (keys.length ? claims.filter((c) => keys.includes(c.id)) : claims).map(citationFor).filter((x): x is Citation => !!x);
  return { score, verdict: verdictOf(score), strong, missing, missingKeys: keys, citations, feedback: null, followUp: null, claimStatuses: statuses };
}

const VivaGradeSchema = z.object({
  covered: z.array(z.string()).default([]),
  wrong: z.array(z.object({ claim_id: z.string(), quote: z.string(), correction: z.string() })).default([]),
  strong: z.array(z.string()).default([]),
  score: z.number().min(0).max(1),
  feedback: z.string(),
  follow_up: z.string().nullable().default(null),
});

export async function gradeVivaAnswer(q: VivaQuestion, answer: string, persona: Persona): Promise<Graded> {
  const claims = await claimsById(q.claimIds);
  const allCites = claims.map(citationFor).filter((x): x is Citation => !!x);
  if (isSkip(answer)) return skipped(allCites, claims.map((c) => c.text), claims.map((c) => c.id));
  const local = gradeVivaLocal(q, claims, answer);
  if (!hasAI() || !claims.length) return local;
  try {
    const r = await aiJSON(
      {
        model: "strong",
        maxTokens: 700,
        system: `You are an oral examiner (${PERSONA_STYLE[persona]}) grading one spoken viva answer against the student's own notes (claims). A claim is covered if the answer expresses its meaning (paraphrase ok). Mark wrong only for a clear contradiction, quoting the student verbatim. strong = up to 3 short phrases quoted verbatim from the answer that were good. feedback = ONE spoken sentence (max 20 words) in persona voice; if the answer was weak do not reveal the answer. follow_up = a short probing question ("Why?", "What happens if...?", "Where would this fail?") about what was missing, or null if the answer was strong.`,
        user: `Question: ${q.text}\nClaims:\n${claims.map((c) => `[${c.id}] ${c.text}`).join("\n")}\n\nStudent answer:\n${answer}\n\nReturn {"covered":[claim ids],"wrong":[{"claim_id","quote","correction"}],"strong":[...],"score":0-1,"feedback","follow_up"}`,
      },
      VivaGradeSchema,
    );
    const covered = new Set(r.covered);
    const wrong = new Map(r.wrong.map((w) => [w.claim_id, w]));
    const statuses: Graded["claimStatuses"] = [];
    const missing: string[] = [];
    const keys: string[] = [];
    for (const c of claims) {
      const w = wrong.get(c.id);
      if (w) {
        statuses.push({ claimId: c.id, status: "wrong", evidence: answer.includes(w.quote) ? w.quote : "", correction: w.correction || c.text, page: c.page });
        missing.push(`You said "${shorten(w.quote, 70)}", but your notes say: ${c.text}`);
        keys.push(c.id);
      } else if (covered.has(c.id)) {
        statuses.push({ claimId: c.id, status: "covered", evidence: bestSnippet(c.text, answer), correction: "", page: c.page });
      } else {
        statuses.push({ claimId: c.id, status: "missing", evidence: "", correction: "", page: c.page });
        missing.push(c.text);
        keys.push(c.id);
      }
    }
    const strong = r.strong.filter((s) => s.trim()).map((s) => `"${shorten(s, 140)}"`);
    const citations = (keys.length ? claims.filter((c) => keys.includes(c.id)) : claims).map(citationFor).filter((x): x is Citation => !!x);
    return { score: clamp01(r.score), verdict: verdictOf(r.score), strong, missing, missingKeys: keys, citations, feedback: r.feedback.trim() || null, followUp: r.follow_up?.trim() || null, claimStatuses: statuses };
  } catch (e) {
    console.warn("[viva] AI grading failed, using local", e);
    return local;
  }
}

function mentions(answer: string, term: string): boolean {
  const a = answer.toLowerCase();
  const t = term.toLowerCase().replace(/\.[a-z0-9]+$/i, "");
  if (t.length < 3) return false;
  return a.includes(t) || (t.includes("-") && a.includes(t.replace(/-/g, " "))) || (t.length > 5 && a.includes(t.slice(0, t.length - 1)));
}

export function gradePlacementLocal(q: VivaQuestion, r: RepoSummary, answer: string): Graded {
  const n = wordCount(answer);
  const terms = [...new Set([...(q.expected ?? []), ...r.terms])];
  const hits = terms.filter((t) => mentions(answer, t));
  const reasons = new Set((answer.match(TRADEOFF) ?? []).map((w) => w.toLowerCase()));
  const hasNumber = /\b\d+(\.\d+)?\s*(%|ms|s|x|k|m|gb|mb|users|requests|rows|qps|rps)?\b/i.test(answer);
  const score = clamp01(0.3 * clamp01(n / 45) + 0.4 * clamp01(hits.length / 3) + 0.3 * clamp01(reasons.size / 2) + (hasNumber ? 0.1 : 0));
  const strong: string[] = [];
  const missing: string[] = [];
  if (hits.length) strong.push(`Specific to your project: mentioned ${hits.slice(0, 4).join(", ")}`);
  if (reasons.size >= 2) strong.push("Explained the reasoning, not just the what");
  if (hasNumber) strong.push("Backed it with a concrete number");
  if (n >= 60) strong.push("Detailed, complete answer");
  const missedExpected = (q.expected ?? []).filter((t) => !mentions(answer, t)).slice(0, 3);
  if (missedExpected.length) missing.push(`Bring in ${missedExpected.join(", ")}`);
  else if (hits.length < 2) missing.push("Name the actual files, folders or libraries from your repo");
  if (reasons.size < 2) missing.push("Say why: the trade-off, or the alternative you rejected");
  if (n < 30) missing.push("Go deeper: a 3-4 sentence answer with one example");
  if (!hasNumber && q.level === 3) missing.push("Add a number (users, latency, data size) to make it concrete");
  return { score, verdict: verdictOf(score), strong, missing, missingKeys: missedExpected, citations: [], feedback: null, followUp: null, claimStatuses: [] };
}

const PlacementGradeSchema = z.object({
  score: z.number().min(0).max(1),
  strong: z.array(z.string()).default([]),
  missing: z.array(z.string()).default([]),
  feedback: z.string(),
  follow_up: z.string().nullable().default(null),
});

export async function gradePlacementAnswer(q: VivaQuestion, r: RepoSummary, answer: string, persona: Persona): Promise<Graded> {
  if (isSkip(answer)) return skipped([], ["No answer given"], q.expected ?? []);
  const local = gradePlacementLocal(q, r, answer);
  if (!hasAI()) return local;
  try {
    const res = await aiJSON(
      {
        model: "strong",
        maxTokens: 600,
        system: `You are a technical interviewer (${PERSONA_STYLE[persona]}) grading a student's spoken answer about their own project. Reward specificity (real files, libraries, numbers), reasoning about trade-offs, and honesty about weak spots. strong/missing = up to 3 short bullet phrases each. feedback = ONE spoken sentence, max 20 words, in persona voice. follow_up = a sharp probing question about the weakest part ("Why?", "What happens if...?", "Where would this fail?") or null if the answer was strong.`,
        user: `${repoBrief(r).slice(0, 4000)}\n\nQuestion: ${q.text}\nA strong answer would mention: ${(q.expected ?? []).join(", ") || "(specifics)"}\n\nStudent answer:\n${answer}\n\nReturn {"score":0-1,"strong":[],"missing":[],"feedback","follow_up"}`,
      },
      PlacementGradeSchema,
    );
    return { ...local, score: clamp01(res.score), verdict: verdictOf(res.score), strong: res.strong.slice(0, 3), missing: res.missing.slice(0, 3), feedback: res.feedback.trim() || null, followUp: res.follow_up?.trim() || null };
  } catch (e) {
    console.warn("[viva] AI placement grading failed, using local", e);
    return local;
  }
}

// ---------- Prepare-better (placement scorecard) ----------

const PrepareSchema = z.object({ prepare: z.array(z.object({ question: z.string(), why: z.string(), outline: z.string() })).min(1).max(3) });

export async function prepareBetter(r: RepoSummary, items: { question: string; answer: string; score: number; expected: string[] }[]): Promise<{ question: string; why: string; outline: string }[]> {
  const weakest = [...items].sort((a, b) => a.score - b.score).slice(0, 3);
  const fallback = weakest.map((w) => ({
    question: w.question,
    why: w.answer.trim() ? `Scored ${Math.round(w.score * 100)}/100: needed more specifics and reasoning.` : "You skipped this one; interviewers almost always ask it.",
    outline: `Open with one sentence answer. Name ${(w.expected.length ? w.expected : r.terms).slice(0, 3).join(", ") || "the exact files and libraries"}. Say why you chose it over an alternative, then one weak spot and how you'd fix it${/scale|break|100/.test(w.question) ? ", with a rough number (users, requests/sec, data size)" : ""}.`,
  }));
  if (!hasAI() || !weakest.length) return fallback;
  try {
    const res = await aiJSON(
      {
        model: "strong",
        maxTokens: 1200,
        system: "You coach a student for a placement interview about their own project. For each weak answer, give a one-line why it was weak and a short answer outline (2-4 sentences) they can practise, grounded in the real repository details. Never invent features not in the brief.",
        user: `${repoBrief(r).slice(0, 4000)}\n\nWeak answers:\n${weakest.map((w, i) => `${i + 1}. Q: ${w.question}\n   A: ${w.answer || "(skipped)"}`).join("\n")}\n\nReturn {"prepare":[{"question","why","outline"}]}`,
      },
      PrepareSchema,
    );
    return res.prepare;
  } catch {
    return fallback;
  }
}

