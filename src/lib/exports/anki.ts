import "server-only";
import { z } from "zod";
import { all, get } from "@/lib/db";
import { aiJSON, hasAI } from "@/lib/ai";
import { buildApkg, escapeHtml, type AnkiCard } from "./apkg";
import { citation, heuristicQuestion } from "./questions";

interface ClaimRow { id: string; text: string; page: number | null; topic: string; file_name: string | null }

export { citation };

const QSchema = z.object({ items: z.array(z.object({ id: z.string(), front: z.string().min(3) })) });

/** Question form per claim: fast model in batches, heuristic fallback. */
async function questionsFor(claims: ClaimRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (hasAI()) {
    for (let i = 0; i < claims.length; i += 40) {
      const batch = claims.slice(i, i + 40);
      try {
        const r = await aiJSON(
          {
            model: "fast",
            cache: true,
            maxTokens: 3000,
            system:
              "You turn study-note claims into flashcard questions. Each question must be answerable by the claim, must not contain the answer, and be under 20 words. Keep the student's terminology.",
            user: `Return {"items":[{"id","front"}]} with one question per claim.\n\n${JSON.stringify(batch.map((c) => ({ id: c.id, topic: c.topic, claim: c.text })))}`,
          },
          QSchema,
        );
        for (const it of r.items) out.set(it.id, it.front.trim());
      } catch (e) {
        console.warn("[anki] AI questions failed, using heuristic", e);
      }
    }
  }
  for (const c of claims) if (!out.has(c.id)) out.set(c.id, heuristicQuestion(c.text, c.topic));
  return out;
}

/** Build an .apkg for a subject: one card per claim. */
export async function buildSubjectApkg(subjectId: string): Promise<{ fileName: string; data: Buffer; cards: number }> {
  const subject = await get<{ name: string }>("SELECT name FROM subjects WHERE id=?", subjectId);
  if (!subject) throw new Error("Subject not found");
  const claims = await all<ClaimRow>(
    `SELECT c.id, c.text, c.page, t.name AS topic, s.file_name
     FROM claims c JOIN topics t ON t.id=c.topic_id LEFT JOIN sources s ON s.id=c.source_id
     WHERE t.subject_id=? ORDER BY t.position, t.name, c.position`,
    subjectId,
  );
  const q = await questionsFor(claims);
  const cards: AnkiCard[] = claims.map((c) => {
    const cite = citation(c.file_name, c.page);
    return {
      key: c.id,
      front: escapeHtml(q.get(c.id)!),
      back: `${escapeHtml(c.text)}${cite ? `<br><span class=cite>${escapeHtml(`${c.topic} ${cite}`)}</span>` : ""}`,
      tags: ["Samjha", c.topic],
    };
  });
  const data = await buildApkg(`Samjha::${subject.name.replace(/::/g, ":")}`, cards);
  return { fileName: `${safeFileName(subject.name)}.apkg`, data, cards: cards.length };
}

export function safeFileName(s: string): string {
  return s.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "samjha";
}

/** Content-Disposition with an ASCII fallback + UTF-8 name. */
export function attachment(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
