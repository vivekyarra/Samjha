import "server-only";
import { all, get } from "@/lib/db";
import { getClaimMastery } from "@/lib/mastery";
import type { Mastery } from "@/lib/types";
import { buildGapsPdf, type GapSubject, type GapTopic } from "./gapsPdf";

export { GAPS_TITLE } from "./gapsPdf";

// ---------- data ----------

async function claimMastery(userId: string, claimIds: string[]): Promise<Map<string, Mastery>> {
  if (!claimIds.length) return new Map();
  try {
    return new Map(Object.entries(await getClaimMastery(userId, claimIds)));
  } catch (e) {
    console.warn("[gaps] getClaimMastery failed, using claim_cards", e);
    const rows = await all<{ claim_id: string; mastery: Mastery }>(
      `SELECT claim_id, mastery FROM claim_cards WHERE user_id=? AND claim_id IN (${claimIds.map(() => "?").join(",")})`,
      userId,
      ...claimIds,
    );
    return new Map(rows.map((r) => [r.claim_id, r.mastery]));
  }
}

/** Buddy text → short plain sentences (≤ maxChars), without the closing prompts. */
export function shortExplanation(text: string, maxChars = 360): string {
  const plain = text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\b(now explain it back to me|want me to go on)\b[^.?!]*[.?!]?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= maxChars) return plain;
  const sentences = plain.match(/[^.!?]+[.!?]+/g) ?? [plain];
  let out = "";
  for (const s of sentences) {
    if ((out + s).length > maxChars) break;
    out += s;
  }
  return (out || plain.slice(0, maxChars - 1) + "…").trim();
}

async function latestBuddyExplanation(userId: string, topicId: string): Promise<string | null> {
  const rows = await all<{ text: string }>(
    `SELECT bm.text FROM buddy_messages bm JOIN attempts a ON a.id=bm.attempt_id
     WHERE a.user_id=? AND a.topic_id=? AND bm.role NOT IN ('user','student') AND length(bm.text) > 20
     ORDER BY bm.created_at DESC LIMIT 5`,
    userId,
    topicId,
  );
  if (!rows.length) return null;
  const shortest = rows.map((r) => shortExplanation(r.text)).sort((a, b) => a.length - b.length)[0];
  return shortest || null;
}

async function latestCorrection(userId: string, claimId: string): Promise<string | null> {
  return (
    (await get<{ correction: string | null }>(
      `SELECT cr.correction FROM claim_results cr JOIN attempts a ON a.id=cr.attempt_id
       WHERE a.user_id=? AND cr.claim_id=? AND cr.status IN ('wrong','missing') AND cr.correction IS NOT NULL AND cr.correction != ''
       ORDER BY a.created_at DESC LIMIT 1`,
      userId,
      claimId,
    ))?.correction ?? null
  );
}

export async function loadGaps(userId: string, subjectId: string): Promise<GapSubject> {
  const subject = await get<{ id: string; name: string; exam_date: string | null }>("SELECT id, name, exam_date FROM subjects WHERE id=?", subjectId);
  if (!subject) throw new Error("Subject not found");
  const rows = await all<{ id: string; text: string; page: number | null; topic_id: string; topic: string; file_name: string | null }>(
    `SELECT c.id, c.text, c.page, t.id AS topic_id, t.name AS topic, s.file_name
     FROM claims c JOIN topics t ON t.id=c.topic_id LEFT JOIN sources s ON s.id=c.source_id
     WHERE t.subject_id=? ORDER BY t.position, t.name, c.position`,
    subjectId,
  );
  // Only topics the student has explained at least once: untouched topics are listed by name, not as gaps.
  const attempted = new Set(
    (await all<{ topic_id: string }>(
      "SELECT DISTINCT a.topic_id FROM attempts a JOIN topics t ON t.id=a.topic_id WHERE a.user_id=? AND t.subject_id=?",
      userId,
      subjectId,
    )).map((r) => r.topic_id),
  );
  const notStarted = [...new Set(rows.filter((r) => !attempted.has(r.topic_id)).map((r) => r.topic))];
  const mastery = await claimMastery(userId, rows.filter((r) => attempted.has(r.topic_id)).map((r) => r.id));
  const topics = new Map<string, GapTopic>();
  for (const r of rows) {
    const m = mastery.get(r.id);
    if (m !== "red" && m !== "amber") continue;
    let t = topics.get(r.topic_id);
    if (!t) topics.set(r.topic_id, (t = { id: r.topic_id, name: r.topic, explanation: null, claims: [] }));
    t.claims.push({ id: r.id, text: r.text, page: r.page, file_name: r.file_name, mastery: m, correction: await latestCorrection(userId, r.id) });
  }
  const list = [...topics.values()];
  for (const t of list) t.explanation = await latestBuddyExplanation(userId, t.id);
  // Red-heavy topics first.
  list.sort((a, b) => b.claims.filter((c) => c.mastery === "red").length - a.claims.filter((c) => c.mastery === "red").length);
  return { id: subject.id, name: subject.name, examDate: subject.exam_date, topics: list, notStarted };
}

/** Gaps-only sheet for one subject, or all of the user's subjects when subjectId is omitted. */
export async function gapsPdfForUser(userId: string, studentName: string, subjectIds: string[]): Promise<Uint8Array> {
  const subjects: GapSubject[] = [];
  for (const id of subjectIds) subjects.push(await loadGaps(userId, id));
  return buildGapsPdf(subjects, studentName);
}
