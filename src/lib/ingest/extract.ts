// Topic + claim extraction (spec §8.2). AI with strict schema when available; built-in engine otherwise or on any error.
import "server-only";
import { z } from "zod";
import { aiJSON, aiText, hasAI } from "@/lib/ai";
import { cosine, embed } from "./embed";
import { localExtract, type Extraction, type ExtractedTopic } from "./heuristic";
import { cleanTopicName, type PageText } from "./text";

const ExtractionSchema = z.object({
  topics: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        claims: z.array(z.object({ text: z.string().min(3).max(400), page: z.coerce.number().int().catch(0) })).default([]),
        prerequisites: z.array(z.string()).optional().default([]),
      }),
    )
    .default([]),
});

const SYSTEM = `You turn a student's own notes into topics and the key claims they must be able to explain.
Rules:
- Topics: short specific noun phrases (1-5 words), e.g. "Backpropagation". Never generic names like "Introduction", "Summary", "Lecture 3".
- Claims: 3-8 per topic. Each is one short, testable, declarative sentence (max 30 words) a student could be asked to explain.
- Claims must come from the notes only. No outside facts, no examples, no logistics (dates, homework, slides).
- "page" is the number from the [p.N] marker of the text the claim comes from.
- prerequisites: names of other topics (from this output or the existing topics) that must be understood first.
- If the notes continue a topic from the existing list, reuse that exact name.
Output schema: {"topics":[{"name":string,"claims":[{"text":string,"page":number}],"prerequisites":[string]}]}`;

const BATCH_CHARS = 24_000;
const CONCURRENCY = 6;
const BATCH_TIMEOUT_MS = 50_000;

function batches(pages: PageText[]): PageText[][] {
  const out: PageText[][] = [];
  let cur: PageText[] = [], size = 0;
  for (const p of pages) {
    if (cur.length && size + p.text.length > BATCH_CHARS) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(p);
    size += p.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Snap each claim to a page inside the batch; drop claims with no support in the notes. */
function ground(topics: ExtractedTopic[], pages: PageText[]): ExtractedTopic[] {
  const pageVecs = pages.map((p) => ({ page: p.page, vec: embed(p.text) }));
  const valid = new Set(pages.map((p) => p.page));
  return topics.map((t) => ({
    name: cleanTopicName(t.name),
    prerequisites: t.prerequisites.map(cleanTopicName).filter(Boolean),
    claims: t.claims.flatMap((c) => {
      const text = c.text.replace(/\s+/g, " ").trim();
      const v = embed(text);
      let best = { page: pages[0].page, sim: -1 };
      for (const pv of pageVecs) {
        const sim = cosine(v, pv.vec);
        if (sim > best.sim) best = { page: pv.page, sim };
      }
      if (best.sim < 0.08) return [];
      const page = valid.has(c.page) ? c.page : best.page;
      return [{ text: /[.!?]$/.test(text) ? text : text + ".", page }];
    }),
  }));
}

async function aiBatch(pages: PageText[], existing: string[], singleTopic?: string): Promise<ExtractedTopic[]> {
  const notes = pages.map((p) => `[p.${p.page}]\n${p.text}`).join("\n\n");
  const ctx = singleTopic
    ? `All of these notes are about the topic "${singleTopic}". Return exactly one topic named "${singleTopic}".`
    : existing.length
      ? `Existing topics in this subject: ${existing.slice(0, 80).map((n) => `"${n}"`).join(", ")}.`
      : "This subject has no topics yet.";
  const res = await aiJSON(
    { system: SYSTEM, user: `${ctx}\n\nNotes:\n${notes}`, model: "strong", maxTokens: 4000, cache: true, json: true },
    ExtractionSchema,
  );
  return ground(res.topics, pages);
}

export interface ExtractOptions {
  existingTopicNames: string[];
  defaultName: string;
  singleTopic?: string;
  onBatch?: (done: number, total: number) => void;
}

/** Extract topics from pages. Batches run in parallel; any batch that errors or times out uses the built-in engine. */
export async function extractTopics(pages: PageText[], opts: ExtractOptions): Promise<{ extraction: Extraction; engine: "ai" | "built-in" | "mixed" }> {
  const local = (ps: PageText[]) => localExtract(ps, { defaultName: opts.defaultName, singleTopic: opts.singleTopic }).topics;
  if (!pages.length) return { extraction: { topics: [] }, engine: "built-in" };
  if (!hasAI()) {
    const topics = local(pages);
    opts.onBatch?.(1, 1);
    return { extraction: { topics }, engine: "built-in" };
  }
  const groups = batches(pages);
  const results: ExtractedTopic[][] = new Array(groups.length);
  let done = 0, aiOk = 0;
  let next = 0;
  const worker = async () => {
    while (next < groups.length) {
      const i = next++;
      try {
        const r = await withTimeout(aiBatch(groups[i], opts.existingTopicNames, opts.singleTopic), BATCH_TIMEOUT_MS);
        results[i] = r.some((t) => t.claims.length) ? r : local(groups[i]);
        if (r.some((t) => t.claims.length)) aiOk++;
      } catch (e) {
        console.warn("[samjha ingest] AI extraction unavailable for a batch, using built-in engine:", e instanceof Error ? e.message.slice(0, 120) : e);
        results[i] = local(groups[i]);
      }
      opts.onBatch?.(++done, groups.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, groups.length) }, worker));
  const engine = aiOk === groups.length ? "ai" : aiOk === 0 ? "built-in" : "mixed";
  return { extraction: { topics: results.flat() }, engine };
}

/** Transcribe a photo of notes with the model's vision input. Returns null when no AI is configured or on any error. */
export async function transcribeImage(base64: string, mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"): Promise<string | null> {
  if (!hasAI()) return null;
  try {
    const text = await withTimeout(
      aiText({
        system: "You transcribe photos of handwritten or printed study notes into clean text.",
        user:
          "Transcribe all the text in this image in reading order. Use '# ' for titles/headings you can see, '- ' for bullet points, keep formulas as plain text. " +
          "Write [unclear] for parts you cannot read. Output only the transcription.",
        images: [{ mediaType, base64 }],
        model: "strong",
        maxTokens: 4000,
        cache: true,
      }),
      55_000,
    );
    return text.trim() || null;
  } catch (e) {
    console.warn("[samjha ingest] image transcription unavailable:", e instanceof Error ? e.message.slice(0, 120) : e);
    return null;
  }
}
