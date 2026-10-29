// Class heatmap (F9). Privacy first: every query below returns aggregate counts only; nothing per-student leaves this module.
import "server-only";
import crypto from "node:crypto";
import { z } from "zod";
import { all, get, run, logEvent } from "@/lib/db";
import { hasAI, aiJSON } from "@/lib/ai";
import { topicColour } from "@/lib/mastery";
import type { Subject } from "@/lib/types";
import {
  anonymise,
  buildClassHeatmap,
  fallbackMisconception,
  pickMostMisunderstood,
  type ClaimCount,
  type ClaimInput,
  type ClassHeatmap,
  type PhraseCount,
  type TopicCount,
  type TopicInput,
} from "./aggregate";

export type { ClassHeatmap, ClassTopicCell, ClassClaimCell } from "./aggregate";
export { MIN_STUDENTS } from "./aggregate";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const CODE_LEN = 8;
const SECRET = process.env.SAMJHA_SECRET || "samjha-dev-secret-change-me";

class HttpError extends Response {
  constructor(status: number, error: string) {
    super(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });
  }
}

export function normaliseCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function generateCode(): Promise<string> {
  for (let tries = 0; tries < 20; tries++) {
    let c = "";
    for (let i = 0; i < CODE_LEN; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!await get("SELECT 1 FROM subjects WHERE join_code=?", c)) return c;
  }
  throw new Error("Could not generate a join code");
}

/** Owner only. Marks the subject shared and returns its (stable) join code. Throws a 403/404 Response otherwise. */
export async function shareSubject(userId: string, subjectId: string): Promise<{ code: string; subjectName: string }> {
  const s = await get<Subject>("SELECT * FROM subjects WHERE id=?", subjectId);
  if (!s) throw new HttpError(404, "Subject not found");
  if (s.owner_id !== userId) throw new HttpError(403, "Only the person who created this subject can share it");
  const code = s.join_code || await generateCode();
  await run("UPDATE subjects SET is_shared=1, join_code=? WHERE id=?", code, subjectId);
  if (!s.is_shared) await logEvent(userId, "class_shared", { subjectId });
  return { code, subjectName: s.name };
}

export async function subjectByCode(code: string): Promise<{ id: string; name: string; members: number } | null> {
  const c = normaliseCode(code);
  if (c.length !== CODE_LEN) return null;
  const s = await get<{ id: string; name: string }>("SELECT id, name FROM subjects WHERE join_code=? AND is_shared=1", c);
  if (!s) return null;
  const m = await get<{ n: number }>("SELECT COUNT(*) AS n FROM subject_members WHERE subject_id=?", s.id);
  return { ...s, members: Number(m?.n ?? 0) };
}

/** Join a shared subject as a member. Topics/claims are shared; the member's own cards and attempts stay personal. */
export async function joinByCode(userId: string, code: string): Promise<{ subjectId: string; name: string; alreadyMember: boolean }> {
  const s = await subjectByCode(code);
  if (!s) throw new HttpError(404, "That join code doesn't match any shared subject");
  const existing = await get("SELECT 1 FROM subject_members WHERE subject_id=? AND user_id=?", s.id, userId);
  if (!existing) {
    await run("INSERT INTO subject_members (subject_id,user_id,role) VALUES (?,?,'member')", s.id, userId);
    await logEvent(userId, "class_joined", { subjectId: s.id });
  }
  return { subjectId: s.id, name: s.name, alreadyMember: !!existing };
}

interface CountRow { claim_id: string; green: number; wrong: number; wrong_marks: number }

async function claimCounts(subjectId: string): Promise<ClaimCount[]> {
  const green = await all<{ claim_id: string; n: number }>(
    `SELECT cc.claim_id, COUNT(DISTINCT cc.user_id) AS n
       FROM claim_cards cc
       JOIN claims c ON c.id = cc.claim_id
       JOIN topics t ON t.id = c.topic_id
       JOIN subject_members m ON m.subject_id = t.subject_id AND m.user_id = cc.user_id
      WHERE t.subject_id = ? AND cc.mastery = 'green'
        AND EXISTS (SELECT 1 FROM attempts a WHERE a.user_id = cc.user_id AND a.topic_id = t.id)
      GROUP BY cc.claim_id`,
    subjectId,
  );
  const wrong = await all<{ claim_id: string; n: number; marks: number }>(
    `SELECT cr.claim_id, COUNT(DISTINCT a.user_id) AS n, COUNT(*) AS marks
       FROM claim_results cr
       JOIN attempts a ON a.id = cr.attempt_id
       JOIN claims c ON c.id = cr.claim_id
       JOIN topics t ON t.id = c.topic_id
       JOIN subject_members m ON m.subject_id = t.subject_id AND m.user_id = a.user_id
      WHERE t.subject_id = ? AND cr.status = 'wrong'
      GROUP BY cr.claim_id`,
    subjectId,
  );
  const map = new Map<string, CountRow>();
  const row = (id: string) => map.get(id) ?? map.set(id, { claim_id: id, green: 0, wrong: 0, wrong_marks: 0 }).get(id)!;
  for (const g of green) row(g.claim_id).green = Number(g.n);
  for (const w of wrong) Object.assign(row(w.claim_id), { wrong: Number(w.n), wrong_marks: Number(w.marks) });
  return [...map.values()];
}

async function loadInputs(subjectId: string) {
  const subject = await get<{ id: string; name: string }>("SELECT id, name FROM subjects WHERE id=?", subjectId);
  if (!subject) return null;
  const students = Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM subject_members WHERE subject_id=?", subjectId))?.n ?? 0);
  const topics = await all<TopicInput>("SELECT id, name, position FROM topics WHERE subject_id=?", subjectId);
  const claims = await all<ClaimInput>(
    "SELECT c.id, c.topic_id, c.text, c.source_id, c.page, c.position FROM claims c JOIN topics t ON t.id=c.topic_id WHERE t.subject_id=?",
    subjectId,
  );
  const topicCounts = await all<TopicCount>(
    `SELECT a.topic_id, COUNT(DISTINCT a.user_id) AS attempted
       FROM attempts a
       JOIN topics t ON t.id = a.topic_id
       JOIN subject_members m ON m.subject_id = t.subject_id AND m.user_id = a.user_id
      WHERE t.subject_id = ?
      GROUP BY a.topic_id`,
    subjectId,
  );
  return { subject, students, topics, claims, topicCounts, claimCounts: await claimCounts(subjectId) };
}

/** Anonymous class heatmap. Topics with fewer than 5 distinct students are suppressed (no shares exposed). */
export async function classHeatmap(subjectId: string): Promise<ClassHeatmap | null> {
  const d = await loadInputs(subjectId);
  if (!d) return null;
  return buildClassHeatmap({
    subjectId,
    subjectName: d.subject.name,
    students: d.students,
    topics: d.topics,
    claims: d.claims,
    topicCounts: d.topicCounts,
    claimCounts: d.claimCounts,
    colour: topicColour,
  });
}

export interface MisunderstoodClaim {
  claimId: string;
  text: string;
  topicName: string;
  /** Distinct students who had it marked wrong. */
  wrong: number;
  attempted: number;
  sourceId: string | null;
  page: number | null;
  misconception: string;
}

const misconceptionSchema = z.object({ sentence: z.string().min(5).max(400) });

async function phraseCounts(claimId: string, column: "correction" | "evidence", subjectId: string): Promise<PhraseCount[]> {
  return (await all<{ text: string; n: number }>(
    `SELECT MIN(TRIM(cr.${column})) AS text, COUNT(DISTINCT a.user_id) AS n
       FROM claim_results cr
       JOIN attempts a ON a.id = cr.attempt_id
       JOIN subject_members m ON m.subject_id = ? AND m.user_id = a.user_id
      WHERE cr.claim_id = ? AND cr.status = 'wrong' AND IFNULL(TRIM(cr.${column}), '') <> ''
      GROUP BY LOWER(TRIM(cr.${column}))
      ORDER BY n DESC
      LIMIT 15`,
    subjectId,
    claimId,
  )).map((r) => ({ text: r.text, n: Number(r.n) }));
}

async function summariseMisconception(claimText: string, corrections: PhraseCount[], phrases: PhraseCount[], names: string[]): Promise<string> {
  const fallback = fallbackMisconception(claimText, corrections, phrases, names);
  if (!hasAI() || (!corrections.length && !phrases.length)) return fallback;
  try {
    const list = (xs: PhraseCount[]) => xs.map((x) => `- (${x.n}) ${anonymise(x.text, names).slice(0, 200)}`).join("\n") || "- (none)";
    const r = await aiJSON(
      {
        model: "fast",
        maxTokens: 200,
        cache: true,
        system:
          "You summarise how a class misunderstands one claim from their course notes, for a professor. Write ONE anonymous sentence (max 30 words) in the form \"Many students think …; the notes say ….\" Never quote a student verbatim, never mention names, numbers of people or individuals. Return {\"sentence\": string}.",
        user: `Claim from the notes: ${claimText}\n\nGrader corrections (count of students):\n${list(corrections)}\n\nWhat students wrote, anonymised (count of students):\n${list(phrases)}`,
      },
      misconceptionSchema,
    );
    const s = anonymise(r.sentence, names).replace(/\s+/g, " ").trim();
    return s.length > 260 ? fallback : s;
  } catch {
    return fallback;
  }
}

/** Claims most often marked wrong across members (only topics with ≥5 students), each with one anonymous misconception sentence. */
export async function mostMisunderstood(subjectId: string, limit = 5, heatmap?: ClassHeatmap | null): Promise<MisunderstoodClaim[]> {
  const d = await loadInputs(subjectId);
  if (!d) return [];
  const hm = heatmap ?? await classHeatmap(subjectId);
  if (!hm) return [];
  const picks = pickMostMisunderstood(hm, d.claimCounts, limit);
  if (!picks.length) return [];
  const names = (await all<{ name: string }>(
    "SELECT u.name FROM users u JOIN subject_members m ON m.user_id=u.id WHERE m.subject_id=?",
    subjectId,
  )).map((r) => r.name);
  return Promise.all(
    picks.map(async (p) => ({
      claimId: p.claimId,
      text: p.text,
      topicName: p.topicName,
      wrong: p.wrong,
      attempted: p.attempted,
      sourceId: p.sourceId,
      page: p.page,
      misconception: await summariseMisconception(p.text, await phraseCounts(p.claimId, "correction", subjectId), await phraseCounts(p.claimId, "evidence", subjectId), names),
    })),
  );
}

// ---- Shareable professor report token: deterministic HMAC of the subject id ----

const hmac = (subjectId: string) => crypto.createHmac("sha256", SECRET).update(`class-report:${subjectId}`).digest("base64url").slice(0, 22);

export function reportToken(subjectId: string): string {
  return `${subjectId}.${hmac(subjectId)}`;
}

/** Returns the subject id if the token is valid and the subject still exists. */
export async function subjectFromToken(token: string): Promise<string | null> {
  const t = decodeURIComponent(token || "");
  const i = t.lastIndexOf(".");
  if (i <= 0) return null;
  const id = t.slice(0, i);
  const a = Buffer.from(t.slice(i + 1));
  const b = Buffer.from(hmac(id));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return await get("SELECT 1 FROM subjects WHERE id=?", id) ? id : null;
}

export interface ClassView {
  subject: { id: string; name: string; isShared: boolean; isOwner: boolean; joinCode: string | null };
  heatmap: ClassHeatmap;
  misunderstood: MisunderstoodClaim[];
  reportToken: string;
}

/** Everything the class page / API needs. Caller must have checked membership. */
export async function classView(userId: string | null, subjectId: string): Promise<ClassView | null> {
  const s = await get<Subject>("SELECT * FROM subjects WHERE id=?", subjectId);
  if (!s) return null;
  const heatmap = await classHeatmap(subjectId);
  if (!heatmap) return null;
  const misunderstood = await mostMisunderstood(subjectId, 5, heatmap);
  return {
    subject: { id: s.id, name: s.name, isShared: !!s.is_shared, isOwner: s.owner_id === userId, joinCode: s.is_shared ? s.join_code : null },
    heatmap,
    misunderstood,
    reportToken: reportToken(subjectId),
  };
}

export function joinUrl(origin: string, code: string): string {
  return `${origin.replace(/\/$/, "")}/join/${code}`;
}

/** Public origin for share links: env override, else the request's host headers. */
export function appOrigin(h?: Pick<Headers, "get">): string {
  const env = process.env.NEXT_PUBLIC_APP_URL || process.env.SAMJHA_URL;
  if (env) return env.replace(/\/$/, "");
  const host = h?.get("x-forwarded-host") || h?.get("host");
  if (!host) return "http://localhost:3000";
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host);
  return `${h?.get("x-forwarded-proto") || (local ? "http" : "https")}://${host}`;
}
