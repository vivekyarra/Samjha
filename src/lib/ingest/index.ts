// A1 Ingestion (spec F1): notes → pages → chunks (+ local embeddings) → topics, claims, prerequisites, merged without duplicates.
import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { all, get, run, tx, newId, now, logEvent, dataDir } from "@/lib/db";
import type { Claim, Subject, Topic } from "@/lib/types";
import { cosine, embed, parseEmbedding } from "./embed";
import { extractTopics, transcribeImage } from "./extract";
import { bestMatch, isDuplicateClaim, matchTopic, nameSimilarity, sameNameScore, topicVector, type ClaimLike } from "./fuzzy";
import { parseSyllabus, type Extraction } from "./heuristic";
import { fileKind, imageMediaType, parsePdf, parsePlainText } from "./parse";
import { cleanTopicName, normClaim, splitSentences, splitTextIntoPages, type PageText } from "./text";

export { embed } from "./embed";
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const SYLLABUS_MIME = "text/x-syllabus";
const MAX_CLAIMS_PER_TOPIC = 12;

/** A problem the student can act on (shown as-is in the UI). */
export class IngestError extends Error {
  constructor(message: string, public status = 422) {
    super(message);
  }
}

// ---------- subjects ----------

export async function createSubject(userId: string, name: string, examDate?: string | null): Promise<Subject> {
  const id = newId("s_");
  const clean = name.trim().slice(0, 120) || "My subject";
  await tx(async () => {
    await run("INSERT INTO subjects (id,owner_id,name,exam_date,created_at) VALUES (?,?,?,?,?)", id, userId, clean, examDate || null, now());
    await run("INSERT OR IGNORE INTO subject_members (subject_id,user_id,role) VALUES (?,?,?)", id, userId, "owner");
  });
  await logEvent(userId, "subject_created", { subjectId: id });
  return (await get<Subject>("SELECT * FROM subjects WHERE id=?", id))!;
}

export type SubjectListItem = Subject & { role: string; topic_count: number; claim_count: number; source_count: number };

export async function listSubjects(userId: string): Promise<SubjectListItem[]> {
  return all<SubjectListItem>(
    `SELECT s.*, m.role,
       (SELECT COUNT(*) FROM topics t WHERE t.subject_id=s.id) AS topic_count,
       (SELECT COUNT(*) FROM claims c JOIN topics t ON t.id=c.topic_id WHERE t.subject_id=s.id) AS claim_count,
       (SELECT COUNT(*) FROM sources so WHERE so.subject_id=s.id) AS source_count
     FROM subjects s JOIN subject_members m ON m.subject_id=s.id AND m.user_id=?
     ORDER BY s.created_at DESC`,
    userId,
  );
}

export async function getSubject(subjectId: string): Promise<Subject | null> {
  return await get<Subject>("SELECT * FROM subjects WHERE id=?", subjectId) ?? null;
}

export type TopicWithClaims = Topic & { claims: Claim[] };
export interface SubjectGraph {
  subject: Subject;
  topics: TopicWithClaims[];
  prerequisites: { topic_id: string; depends_on_topic_id: string }[];
}

export async function getSubjectGraph(subjectId: string): Promise<SubjectGraph> {
  const subject = await getSubject(subjectId);
  if (!subject) throw new IngestError("Subject not found", 404);
  const topics = await all<Topic>("SELECT * FROM topics WHERE subject_id=? ORDER BY position, rowid", subjectId);
  const claims = await all<Claim>(
    "SELECT c.* FROM claims c JOIN topics t ON t.id=c.topic_id WHERE t.subject_id=? ORDER BY c.position, c.rowid",
    subjectId,
  );
  const byTopic = new Map<string, Claim[]>();
  for (const c of claims) {
    const list = byTopic.get(c.topic_id) ?? [];
    list.push(c);
    byTopic.set(c.topic_id, list);
  }
  const prerequisites = await all<{ topic_id: string; depends_on_topic_id: string }>(
    "SELECT p.topic_id, p.depends_on_topic_id FROM prerequisites p JOIN topics t ON t.id=p.topic_id WHERE t.subject_id=?",
    subjectId,
  );
  return { subject, topics: topics.map((t) => ({ ...t, claims: byTopic.get(t.id) ?? [] })), prerequisites };
}

export async function getTopicWithClaims(topicId: string): Promise<TopicWithClaims | null> {
  const t = await get<Topic>("SELECT * FROM topics WHERE id=?", topicId);
  if (!t) return null;
  return { ...t, claims: await all<Claim>("SELECT * FROM claims WHERE topic_id=? ORDER BY position, rowid", topicId) };
}

export async function listSources(subjectId: string) {
  return all<{ id: string; file_name: string; mime: string | null; pages: number; url: string | null; created_at: string }>(
    "SELECT id,file_name,mime,pages,url,created_at FROM sources WHERE subject_id=? ORDER BY created_at",
    subjectId,
  );
}

// ---------- topic search ----------

export interface TopicMatch { id: string; name: string; subject_id: string; subject_name: string; score: number }

export async function searchTopics(userId: string, query: string, limit = 8): Promise<TopicMatch[]> {
  const q = query.trim();
  if (!q) return [];
  const rows = await all<{ id: string; name: string; subject_id: string; subject_name: string }>(
    `SELECT t.id, t.name, t.subject_id, s.name AS subject_name FROM topics t
     JOIN subjects s ON s.id=t.subject_id JOIN subject_members m ON m.subject_id=s.id AND m.user_id=?`,
    userId,
  );
  return rows
    .map((r) => ({ ...r, score: Math.round(nameSimilarity(q, r.name) * 1000) / 1000 }))
    .filter((r) => r.score >= 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Fuzzy topic lookup across the user's subjects ("open backprop"). */
export async function findTopicByName(userId: string, query: string): Promise<{ id: string; name: string; subject_id: string } | null> {
  const best = (await searchTopics(userId, query, 1))[0];
  return best && best.score >= 0.55 ? { id: best.id, name: best.name, subject_id: best.subject_id } : null;
}

// ---------- retrieval ----------

export interface RetrievedChunk { id: string; source_id: string; file_name: string; page: number; text: string; score: number }

export async function retrieveChunks(subjectId: string, query: string, k = 5): Promise<RetrievedChunk[]> {
  const q = embed(query);
  const rows = await all<{ id: string; source_id: string; file_name: string; page: number; text: string; embedding: string | null }>(
    "SELECT c.id, c.source_id, s.file_name, c.page, c.text, c.embedding FROM chunks c JOIN sources s ON s.id=c.source_id WHERE s.subject_id=?",
    subjectId,
  );
  return rows
    .map((r) => ({ id: r.id, source_id: r.source_id, file_name: r.file_name, page: r.page, text: r.text, score: cosine(q, parseEmbedding(r.embedding) ?? embed(r.text)) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((r) => ({ ...r, score: Math.round(r.score * 1000) / 1000 }));
}

// ---------- sources / citation pages ----------

export async function getSourcePage(sourceId: string, page: number) {
  const source = await get<{ id: string; subject_id: string; file_name: string; mime: string | null; pages: number; url: string | null }>(
    "SELECT id,subject_id,file_name,mime,pages,url FROM sources WHERE id=?",
    sourceId,
  );
  if (!source) return null;
  const p = Math.min(Math.max(1, Math.floor(page) || 1), Math.max(1, source.pages));
  const parts = await all<{ text: string }>("SELECT text FROM chunks WHERE source_id=? AND page=? ORDER BY rowid", sourceId, p);
  return { source, page: p, pages: source.pages, text: parts.map((x) => x.text).join("\n") };
}

/** Sentences on the page that best support a claim (for highlighting in the citation viewer). */
export function supportingSentences(pageText: string, claimText: string, max = 2): string[] {
  const v = embed(claimText);
  return splitSentences(pageText.replace(/\n+/g, " "))
    .map((s) => ({ s, sim: cosine(v, embed(s)) }))
    .filter((x) => x.sim >= 0.2)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, max)
    .map((x) => x.s);
}

// ---------- ingestion ----------

export interface IngestProgress { stage: "reading" | "indexing" | "extracting" | "merging" | "done"; done?: number; total?: number; message: string }

export interface IngestOptions {
  subjectId: string;
  fileName: string;
  mime: string;
  data?: Buffer;
  text?: string;
  url?: string;
  /** Attach everything to this existing topic (notes added for one topic, e.g. after a syllabus). */
  topicId?: string;
  onProgress?: (p: IngestProgress) => void;
}

export interface IngestResult {
  sourceId: string;
  topicsCreated: number;
  claimsCreated: number;
  topicsMerged: number;
  pages: number;
  engine: "ai" | "built-in" | "mixed";
  topicIds: string[];
  /** Same file already in this subject: nothing new was added. */
  duplicate?: boolean;
  /** Friendly note to show the student. */
  notice?: string;
}

function chunkPage(text: string, target = 900): string[] {
  if (text.length <= target * 1.4) return [text];
  const out: string[] = [];
  let cur = "";
  for (const para of text.split(/\n/)) {
    const pieces = para.length > target ? splitSentences(para) : [para];
    for (const piece of pieces) {
      if (cur && cur.length + piece.length + 1 > target) {
        out.push(cur);
        cur = "";
      }
      cur += (cur ? "\n" : "") + piece;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function saveOriginal(sourceId: string, fileName: string, data: Buffer): string | null {
  try {
    const dir = path.join(dataDir(), "uploads");
    fs.mkdirSync(dir, { recursive: true });
    const ext = (path.extname(fileName) || "").toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 8);
    const p = path.join(dir, sourceId + ext);
    fs.writeFileSync(p, data);
    return p;
  } catch {
    return null;
  }
}

/** Ingest one file or text into a subject. Re-uploading the same content is a no-op. */
export async function ingestSource(opts: IngestOptions): Promise<IngestResult> {
  const t0 = Date.now();
  const progress = (p: IngestProgress) => opts.onProgress?.(p);
  const subject = await getSubject(opts.subjectId);
  if (!subject) throw new IngestError("Subject not found", 404);
  if (opts.data && opts.data.length > MAX_UPLOAD_BYTES) throw new IngestError("That file is over 20 MB. Try splitting it into smaller files.", 413);
  if (opts.topicId && !await get("SELECT 1 FROM topics WHERE id=? AND subject_id=?", opts.topicId, opts.subjectId)) throw new IngestError("Topic not found in this subject", 404);

  const fileName = (opts.fileName || "Pasted notes").slice(0, 200);
  const mime = (opts.mime || "").toLowerCase();
  const syllabus = mime === SYLLABUS_MIME;
  progress({ stage: "reading", message: "Reading your notes" });

  const hash = crypto.createHash("sha256").update(opts.data ?? Buffer.from(opts.text ?? "", "utf8")).update(syllabus ? "syllabus" : "").update(opts.topicId ?? "").digest("hex");
  const dup = await get<{ id: string; pages: number }>("SELECT id, pages FROM sources WHERE subject_id=? AND content_hash=?", opts.subjectId, hash);
  if (dup) {
    progress({ stage: "done", message: "Already added" });
    return { sourceId: dup.id, topicsCreated: 0, claimsCreated: 0, topicsMerged: 0, pages: dup.pages, engine: "built-in", topicIds: [], duplicate: true, notice: "You already added this file, so nothing changed." };
  }

  let pages: PageText[] = [];
  let notice: string | undefined;
  let imageWaiting = false;
  if (syllabus || opts.text != null) {
    pages = parsePlainText(opts.text ?? opts.data?.toString("utf8") ?? "");
  } else if (opts.data) {
    const kind = fileKind(fileName, mime);
    if (kind === "pdf") {
      try {
        pages = await parsePdf(opts.data);
      } catch {
        throw new IngestError("We couldn't open that PDF. If it's password-protected, export an unlocked copy and try again.");
      }
      if (pages.every((p) => p.text.length < 20)) {
        throw new IngestError("This PDF has no selectable text (it looks scanned). Upload photos of the pages instead and Samjha will read them.");
      }
    } else if (kind === "image") {
      const media = imageMediaType(fileName, mime);
      if (!media) throw new IngestError("Please upload images as PNG, JPG, WEBP or GIF.", 415);
      const text = await transcribeImage(opts.data.toString("base64"), media);
      if (text) pages = parsePlainText(text);
      else {
        imageWaiting = true;
        pages = [{ page: 1, text: `Photo of notes: ${fileName}. Reading handwriting works best with an AI key; you can also type or paste these notes.` }];
        notice = "Photo saved. Reading handwriting works best with an AI key, so for now paste or type these notes to turn them into topics.";
      }
    } else if (kind === "text") {
      pages = parsePlainText(opts.data.toString("utf8"));
    } else {
      throw new IngestError("Samjha reads PDF, text, Markdown and photos of notes. Try one of those.", 415);
    }
  }
  pages = pages.filter((p) => p.text.trim().length > 0).map((p, i) => ({ ...p, page: p.page ?? i + 1 }));
  if (!pages.length) throw new IngestError("We couldn't find any text in that. Try another file or paste your notes.");

  // source + chunks
  progress({ stage: "indexing", message: `Indexing ${pages.length} page${pages.length === 1 ? "" : "s"}` });
  const sourceId = newId("src_");
  const storagePath = opts.data ? saveOriginal(sourceId, fileName, opts.data) : null;
  await tx(async () => {
    await run(
      "INSERT INTO sources (id,subject_id,file_name,storage_path,mime,pages,url,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      sourceId, opts.subjectId, fileName, storagePath, syllabus ? SYLLABUS_MIME : mime || null, Math.max(...pages.map((p) => p.page)), opts.url ?? null, hash, now(),
    );
    for (const p of pages) for (const c of chunkPage(p.text)) await run("INSERT INTO chunks (id,source_id,page,text,embedding) VALUES (?,?,?,?,?)", newId("ch_"), sourceId, p.page, c, JSON.stringify(embed(c)));
  });

  // extraction
  let extraction: Extraction = { topics: [] };
  let engine: IngestResult["engine"] = "built-in";
  const targetTopic = opts.topicId ? await get<{ name: string }>("SELECT name FROM topics WHERE id=?", opts.topicId) : undefined;
  if (syllabus) {
    extraction = { topics: parseSyllabus(pages.map((p) => p.text).join("\n")).map((name) => ({ name, claims: [], prerequisites: [] })) };
    if (!extraction.topics.length) notice = "We couldn't spot topic names. Put one topic per line and try again.";
  } else if (!imageWaiting) {
    progress({ stage: "extracting", message: "Finding topics and key claims", done: 0 });
    const existingTopicNames = (await all<{ name: string }>("SELECT name FROM topics WHERE subject_id=? ORDER BY position", opts.subjectId)).map((r) => r.name);
    const res = await extractTopics(pages, {
      existingTopicNames,
      defaultName: targetTopic?.name ?? fileName,
      singleTopic: targetTopic?.name,
      onBatch: (done, total) => progress({ stage: "extracting", message: "Finding topics and key claims", done, total }),
    });
    extraction = res.extraction;
    engine = res.engine;
  }

  progress({ stage: "merging", message: "Merging into your subject" });
  const merged = await tx(() => mergeExtraction(opts.subjectId, sourceId, extraction, { targetTopicId: opts.topicId, keepEmpty: syllabus }));
  if (!syllabus && !imageWaiting && merged.claimsCreated === 0 && !notice) {
    notice = merged.topicsMerged ? "Everything in this file was already in your subject, so no duplicates were added." : "We couldn't find clear statements to turn into claims. Notes with headings and full sentences work best.";
  }
  await logEvent(subject.owner_id, "source_ingested", { subjectId: opts.subjectId, sourceId, pages: pages.length, ms: Date.now() - t0, engine, ...merged, syllabus });
  progress({ stage: "done", message: "Done" });
  return { sourceId, pages: pages.length, engine, notice, ...merged };
}

interface TopicState {
  id: string;
  name: string;
  preExisting: boolean;
  claims: ClaimLike[];
  vec?: number[];
  added: number;
}

function wouldCycle(edges: Map<string, Set<string>>, from: string, to: string): boolean {
  // adding from → to (from depends on to) cycles if `to` already reaches `from`
  const stack = [to];
  const seen = new Set<string>();
  while (stack.length) {
    const n = stack.pop()!;
    if (n === from) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const m of edges.get(n) ?? []) stack.push(m);
  }
  return false;
}

/** Merge extracted topics into a subject: match topics by name + content, skip duplicate claims, link prerequisites. Call inside tx. */
export async function mergeExtraction(
  subjectId: string,
  sourceId: string | null,
  extraction: Extraction,
  opts: { targetTopicId?: string; keepEmpty?: boolean } = {},
): Promise<{ topicsCreated: number; claimsCreated: number; topicsMerged: number; topicIds: string[] }> {
  const topics = await all<{ id: string; name: string }>("SELECT id, name FROM topics WHERE subject_id=? ORDER BY position, rowid", subjectId);
  const claimRows = await all<{ topic_id: string; text: string }>("SELECT c.topic_id, c.text FROM claims c JOIN topics t ON t.id=c.topic_id WHERE t.subject_id=?", subjectId);
  const states: TopicState[] = topics.map((t) => ({ id: t.id, name: t.name, preExisting: true, claims: [], added: 0 }));
  const byId = new Map(states.map((s) => [s.id, s]));
  const subjectKeys = new Set<string>();
  for (const c of claimRows) {
    byId.get(c.topic_id)?.claims.push({ text: c.text, key: normClaim(c.text), vec: embed(c.text) });
    subjectKeys.add(normClaim(c.text));
  }
  let position = ((await get<{ p: number | null }>("SELECT MAX(position) AS p FROM topics WHERE subject_id=?", subjectId))?.p ?? -1) + 1;
  const merged = new Set<string>();
  const created: TopicState[] = [];
  const touched = new Map<number, TopicState>();
  let claimsCreated = 0;

  for (const [i, et] of extraction.topics.entries()) {
    const name = cleanTopicName(et.name);
    if (!name) continue;
    let target: TopicState | undefined = opts.targetTopicId ? byId.get(opts.targetTopicId) : undefined;
    if (!target) {
      const idx = matchTopic(
        { name, claimTexts: et.claims.map((c) => c.text) },
        states.map((s) => ({ name: s.name, claimTexts: s.claims.map((c) => c.text), vec: s.vec ?? (s.vec = topicVector(s.name, s.claims.map((c) => c.text))) })),
      );
      target = idx >= 0 ? states[idx] : undefined;
    }
    if (!target) {
      target = { id: newId("t_"), name, preExisting: false, claims: [], added: 0 };
      await run("INSERT INTO topics (id,subject_id,name,position) VALUES (?,?,?,?)", target.id, subjectId, name, position++);
      states.push(target);
      byId.set(target.id, target);
      created.push(target);
    } else if (target.preExisting) merged.add(target.id);
    touched.set(i, target);

    for (const c of et.claims) {
      const text = c.text.replace(/\s+/g, " ").trim();
      if (text.length < 8 || target.claims.length >= MAX_CLAIMS_PER_TOPIC) continue;
      const key = normClaim(text);
      if (subjectKeys.has(key) || isDuplicateClaim(text, target.claims)) continue;
      await run(
        "INSERT INTO claims (id,topic_id,text,source_id,page,position) VALUES (?,?,?,?,?,?)",
        newId("c_"), target.id, text.slice(0, 400), sourceId, c.page || null, target.claims.length,
      );
      target.claims.push({ text, key, vec: embed(text) });
      target.vec = undefined;
      target.added++;
      subjectKeys.add(key);
      claimsCreated++;
    }
  }

  // new topics that ended up empty (everything was a duplicate) are removed, unless this is a syllabus
  const kept: TopicState[] = [];
  for (const t of created) {
    if (t.claims.length || opts.keepEmpty) {
      kept.push(t);
      continue;
    }
    await run("DELETE FROM topics WHERE id=?", t.id);
    states.splice(states.indexOf(t), 1);
  }

  // prerequisites by name
  const edgeRows = await all<{ topic_id: string; depends_on_topic_id: string }>(
    "SELECT p.topic_id, p.depends_on_topic_id FROM prerequisites p JOIN topics t ON t.id=p.topic_id WHERE t.subject_id=?",
    subjectId,
  );
  const edges = new Map<string, Set<string>>();
  for (const e of edgeRows) (edges.get(e.topic_id) ?? edges.set(e.topic_id, new Set()).get(e.topic_id)!).add(e.depends_on_topic_id);
  for (const [i, et] of extraction.topics.entries()) {
    const from = touched.get(i);
    if (!from || !states.includes(from)) continue;
    for (const pre of et.prerequisites) {
      const m = bestMatch(pre, states, (s) => s.name, 0.72);
      const strong = states.find((s) => sameNameScore(pre, s.name) >= 0.85);
      const to = strong ?? m?.item;
      if (!to || to.id === from.id || edges.get(from.id)?.has(to.id) || wouldCycle(edges, from.id, to.id)) continue;
      await run("INSERT OR IGNORE INTO prerequisites (topic_id, depends_on_topic_id) VALUES (?,?)", from.id, to.id);
      (edges.get(from.id) ?? edges.set(from.id, new Set()).get(from.id)!).add(to.id);
    }
  }

  const topicIds = [...new Set([...touched.values()].filter((t) => states.includes(t)).map((t) => t.id))];
  return { topicsCreated: kept.length, claimsCreated, topicsMerged: merged.size, topicIds };
}

/** Text helpers re-exported for other modules (e.g. sample-subject loading). */
export { splitTextIntoPages };
