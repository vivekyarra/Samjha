// Review/edit operations on extracted topics and claims (spec F1 step 4): rename, merge, split, delete, add.
import "server-only";
import { all, get, run, tx, newId } from "@/lib/db";
import type { Claim, Topic } from "@/lib/types";
import { isDuplicateClaim } from "./fuzzy";
import { IngestError, getTopicWithClaims, type TopicWithClaims } from "./index";
import { cleanTopicName } from "./text";

/** Owner (or the creator of a personal subject) may edit; members can read. */
export async function canEditSubject(userId: string, subjectId: string): Promise<boolean> {
  return !!await get("SELECT 1 FROM subject_members WHERE subject_id=? AND user_id=? AND role='owner'", subjectId, userId);
}

export async function topicSubjectId(topicId: string): Promise<string | null> {
  return (await get<{ subject_id: string }>("SELECT subject_id FROM topics WHERE id=?", topicId))?.subject_id ?? null;
}
export async function claimSubjectId(claimId: string): Promise<string | null> {
  return (await get<{ subject_id: string }>("SELECT t.subject_id FROM claims c JOIN topics t ON t.id=c.topic_id WHERE c.id=?", claimId))?.subject_id ?? null;
}
export async function sourceSubjectId(sourceId: string): Promise<string | null> {
  return (await get<{ subject_id: string }>("SELECT subject_id FROM sources WHERE id=?", sourceId))?.subject_id ?? null;
}

export async function updateSubject(subjectId: string, patch: { name?: string; examDate?: string | null }) {
  if (patch.name !== undefined) await run("UPDATE subjects SET name=? WHERE id=?", patch.name.trim().slice(0, 120), subjectId);
  if (patch.examDate !== undefined) await run("UPDATE subjects SET exam_date=? WHERE id=?", patch.examDate || null, subjectId);
  return get("SELECT * FROM subjects WHERE id=?", subjectId);
}

export async function deleteSubject(subjectId: string) {
  await run("DELETE FROM subjects WHERE id=?", subjectId);
}

export async function updateTopic(topicId: string, patch: { name?: string; inExam?: boolean; position?: number }): Promise<Topic> {
  if (patch.name !== undefined) {
    const name = cleanTopicName(patch.name);
    if (!name) throw new IngestError("Topic name can't be empty", 400);
    await run("UPDATE topics SET name=? WHERE id=?", name, topicId);
  }
  if (patch.inExam !== undefined) await run("UPDATE topics SET in_exam=? WHERE id=?", patch.inExam ? 1 : 0, topicId);
  if (patch.position !== undefined) await run("UPDATE topics SET position=? WHERE id=?", patch.position, topicId);
  return (await get<Topic>("SELECT * FROM topics WHERE id=?", topicId))!;
}

export async function deleteTopic(topicId: string) {
  await run("DELETE FROM topics WHERE id=?", topicId);
}

/** Merge topics into the first one. Claims move over (duplicates dropped), prerequisites and history are kept. */
export async function mergeTopics(ids: string[], name?: string): Promise<TopicWithClaims> {
  const unique = [...new Set(ids)];
  if (unique.length < 2) throw new IngestError("Pick at least two topics to merge", 400);
  const topics = await Promise.all(unique.map((id) => get<Topic>("SELECT * FROM topics WHERE id=?", id)));
  if (topics.some((t) => !t)) throw new IngestError("Topic not found", 404);
  const subj = new Set(topics.map((t) => t!.subject_id));
  if (subj.size !== 1) throw new IngestError("Topics must be in the same subject", 400);
  const [target, ...others] = topics as Topic[];
  await tx(async () => {
    const pool = (await all<Claim>("SELECT * FROM claims WHERE topic_id=?", target.id)).map((c) => ({ text: c.text }));
    let pos = pool.length;
    for (const o of others) {
      for (const c of await all<Claim>("SELECT * FROM claims WHERE topic_id=? ORDER BY position, rowid", o.id)) {
        if (isDuplicateClaim(c.text, pool)) {
          await run("DELETE FROM claims WHERE id=?", c.id);
          continue;
        }
        await run("UPDATE claims SET topic_id=?, position=? WHERE id=?", target.id, pos++, c.id);
        pool.push({ text: c.text });
      }
      await run("UPDATE attempts SET topic_id=? WHERE topic_id=?", target.id, o.id);
      await run("UPDATE OR IGNORE prerequisites SET topic_id=? WHERE topic_id=?", target.id, o.id);
      await run("UPDATE OR IGNORE prerequisites SET depends_on_topic_id=? WHERE depends_on_topic_id=?", target.id, o.id);
      if (o.in_exam) await run("UPDATE topics SET in_exam=1 WHERE id=?", target.id);
      await run("DELETE FROM topics WHERE id=?", o.id);
    }
    await run("DELETE FROM prerequisites WHERE topic_id=depends_on_topic_id");
    if (name?.trim()) await run("UPDATE topics SET name=? WHERE id=?", cleanTopicName(name), target.id);
  });
  return (await getTopicWithClaims(target.id))!;
}

/** Move some claims of a topic into a new topic placed right after it. */
export async function splitTopic(topicId: string, claimIds: string[], name: string): Promise<{ original: TopicWithClaims; created: TopicWithClaims }> {
  const t = await get<Topic>("SELECT * FROM topics WHERE id=?", topicId);
  if (!t) throw new IngestError("Topic not found", 404);
  const owned = (await all<{ id: string }>("SELECT id FROM claims WHERE topic_id=?", topicId)).map((r) => r.id);
  const move = [...new Set(claimIds)].filter((id) => owned.includes(id));
  if (!move.length) throw new IngestError("Pick the claims to move into the new topic", 400);
  if (move.length === owned.length) throw new IngestError("Leave at least one claim in the original topic", 400);
  const clean = cleanTopicName(name) || `${t.name} (part 2)`;
  const newIdValue = newId("t_");
  await tx(async () => {
    await run("UPDATE topics SET position=position+1 WHERE subject_id=? AND position>?", t.subject_id, t.position);
    await run("INSERT INTO topics (id,subject_id,name,position,in_exam) VALUES (?,?,?,?,?)", newIdValue, t.subject_id, clean, t.position + 1, t.in_exam);
    for (const [i, id] of move.entries()) await run("UPDATE claims SET topic_id=?, position=? WHERE id=?", newIdValue, i, id);
    await run("INSERT OR IGNORE INTO prerequisites (topic_id, depends_on_topic_id) SELECT ?, depends_on_topic_id FROM prerequisites WHERE topic_id=?", newIdValue, topicId);
  });
  return { original: (await getTopicWithClaims(topicId))!, created: (await getTopicWithClaims(newIdValue))! };
}

function cleanClaimText(text: string): string {
  let s = text.replace(/\s+/g, " ").trim();
  if (!s) throw new IngestError("Claim text can't be empty", 400);
  s = s[0].toUpperCase() + s.slice(1);
  if (!/[.!?)]$/.test(s)) s += ".";
  return s.slice(0, 400);
}

export async function createClaim(input: { topicId: string; text: string; sourceId?: string | null; page?: number | null; position?: number }): Promise<Claim> {
  const text = cleanClaimText(input.text);
  const existing = await all<Claim>("SELECT * FROM claims WHERE topic_id=?", input.topicId);
  if (isDuplicateClaim(text, existing)) throw new IngestError("That claim is already in this topic", 409);
  const id = newId("c_");
  await run(
    "INSERT INTO claims (id,topic_id,text,source_id,page,position) VALUES (?,?,?,?,?,?)",
    id, input.topicId, text, input.sourceId ?? null, input.page ?? null, input.position ?? existing.length,
  );
  return (await get<Claim>("SELECT * FROM claims WHERE id=?", id))!;
}

export async function updateClaim(claimId: string, patch: { text?: string; page?: number | null; topicId?: string; sourceId?: string | null }): Promise<Claim> {
  if (patch.text !== undefined) await run("UPDATE claims SET text=? WHERE id=?", cleanClaimText(patch.text), claimId);
  if (patch.page !== undefined) await run("UPDATE claims SET page=? WHERE id=?", patch.page, claimId);
  if (patch.sourceId !== undefined) await run("UPDATE claims SET source_id=? WHERE id=?", patch.sourceId, claimId);
  if (patch.topicId !== undefined) {
    const n = (await get<{ n: number }>("SELECT COUNT(*) AS n FROM claims WHERE topic_id=?", patch.topicId))?.n ?? 0;
    await run("UPDATE claims SET topic_id=?, position=? WHERE id=?", patch.topicId, n, claimId);
  }
  return (await get<Claim>("SELECT * FROM claims WHERE id=?", claimId))!;
}

export async function deleteClaim(claimId: string) {
  await run("DELETE FROM claims WHERE id=?", claimId);
}
