// Scores the grader on eval/blind.json: a set written independently of the grader and never used for tuning.
// Run: npx tsx eval/blind.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GRADER_VERSION, builtinGrade } from "../src/lib/grading/core";
import type { ClaimStatus } from "../src/lib/types";

const DIR = path.dirname(fileURLToPath(import.meta.url));
interface TopicDef { id: string; name: string; claims: { id: string; text: string; page: number }[]; notes: { page: number; text: string }[] }
const claims = JSON.parse(fs.readFileSync(path.join(DIR, "claims.json"), "utf8")) as { topics: TopicDef[] };
const blind = JSON.parse(fs.readFileSync(path.join(DIR, "blind.json"), "utf8")) as { items: { id: string; topicId: string; explanation: string; labels: Record<string, ClaimStatus> }[] };
const topics = new Map(claims.topics.map((t) => [t.id, t]));
const HINGLISH = /\b(hai|hain|toh|nahi|mein|kya|matlab|samjho|jaate|karte|wala)\b/i;

let agree = 0, total = 0, hAgree = 0, hTotal = 0;
const conf: Record<string, number> = {};
for (const item of blind.items) {
  const t = topics.get(item.topicId)!;
  const res = builtinGrade({
    topic: t.name,
    claims: t.claims.map((c) => ({ id: c.id, text: c.text, page: c.page })),
    chunks: t.notes.map((n) => ({ text: n.text, page: n.page, fileName: "ml-notes.pdf" })),
    explanation: item.explanation,
  });
  const h = HINGLISH.test(item.explanation);
  for (const [cid, gold] of Object.entries(item.labels)) {
    const pred = res.claims.find((c) => c.claim_id === cid)?.status ?? "missing";
    total++; if (h) hTotal++;
    if (pred === gold) { agree++; if (h) hAgree++; }
    conf[`${gold}->${pred}`] = (conf[`${gold}->${pred}`] ?? 0) + 1;
  }
}
const pct = (a: number, b: number) => ((100 * a) / Math.max(1, b)).toFixed(1);
console.log(`${GRADER_VERSION} blind set: ${pct(agree, total)}% (${agree}/${total}); Hinglish ${pct(hAgree, hTotal)}% (${hAgree}/${hTotal})`);
console.log("gold->pred", conf);
