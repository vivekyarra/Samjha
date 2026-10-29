import "server-only";
import { all, get } from "@/lib/db";
import { citation } from "./anki";

interface AttemptRow { id: string; user_id: string; topic_id: string | null; kind: string; transcript: string; parent_attempt_id: string | null; created_at: string }

const KIND_LABEL: Record<string, string> = {
  explain: "Your explanation",
  explain_back: "Explain-back",
  review: "Review",
  viva: "Viva answer",
  exam_eve: "Exam-eve check",
};
const STATUS_LABEL: Record<string, string> = { covered: "Covered", missing: "Missing", wrong: "Wrong" };

const quote = (s: string) => s.trim().split("\n").map((l) => `> ${l}`).join("\n");
const time = (iso: string) => iso.replace("T", " ").slice(0, 16) + " UTC";

/** The attempt plus every follow-up attempt chained to it (explain-backs, re-tries), oldest first. */
async function attemptChain(root: AttemptRow): Promise<AttemptRow[]> {
  const out: AttemptRow[] = [root];
  const seen = new Set([root.id]);
  for (let i = 0; i < out.length && out.length < 50; i++) {
    for (const child of await all<AttemptRow>("SELECT * FROM attempts WHERE parent_attempt_id=? ORDER BY created_at", out[i].id)) {
      if (!seen.has(child.id)) {
        seen.add(child.id);
        out.push(child);
      }
    }
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function getAttemptOwner(attemptId: string): Promise<string | null> {
  return (await get<{ user_id: string }>("SELECT user_id FROM attempts WHERE id=?", attemptId))?.user_id ?? null;
}

/** Markdown transcript of a session: explanations, grading, and the buddy's replies. */
export async function buildTranscript(attemptId: string): Promise<{ fileName: string; markdown: string }> {
  const root = await get<AttemptRow>("SELECT * FROM attempts WHERE id=?", attemptId);
  if (!root) throw new Error("Attempt not found");
  const topic = root.topic_id
    ? await get<{ name: string; subject: string }>(
        "SELECT t.name, s.name AS subject FROM topics t JOIN subjects s ON s.id=t.subject_id WHERE t.id=?",
        root.topic_id,
      )
    : undefined;
  const title = topic?.name ?? "Session";
  const md: string[] = [`# ${title} — Samjha session transcript`, ""];
  if (topic) md.push(`**Subject:** ${topic.subject}  `);
  md.push(`**Started:** ${time(root.created_at)}`, "");

  for (const a of await attemptChain(root)) {
    md.push(`## ${KIND_LABEL[a.kind] ?? a.kind} · ${time(a.created_at)}`, "");
    md.push(a.transcript.trim() ? quote(a.transcript) : "_(no text)_", "");

    const results = await all<{ status: string; evidence: string | null; correction: string | null; text: string; page: number | null; file_name: string | null }>(
      `SELECT cr.status, cr.evidence, cr.correction, c.text, c.page, s.file_name
       FROM claim_results cr JOIN claims c ON c.id=cr.claim_id LEFT JOIN sources s ON s.id=c.source_id
       WHERE cr.attempt_id=? ORDER BY CASE cr.status WHEN 'wrong' THEN 0 WHEN 'missing' THEN 1 ELSE 2 END, c.position`,
      a.id,
    );
    if (results.length) {
      const covered = results.filter((r) => r.status === "covered").length;
      md.push(`**Result:** ${covered}/${results.length} claims covered`, "");
      for (const r of results) {
        const cite = citation(r.file_name, r.page);
        md.push(`- **${STATUS_LABEL[r.status] ?? r.status}:** ${r.text}${cite ? ` _${cite}_` : ""}`);
        if (r.status === "covered" && r.evidence) md.push(`  - You said: “${r.evidence.trim()}”`);
        if (r.status !== "covered" && r.correction) md.push(`  - Correction: ${r.correction.trim()}`);
      }
      md.push("");
    }

    const msgs = await all<{ role: string; text: string; intent: string | null; created_at: string }>(
      "SELECT role, text, intent, created_at FROM buddy_messages WHERE attempt_id=? ORDER BY created_at",
      a.id,
    );
    if (msgs.length) {
      md.push("### Conversation with your buddy", "");
      for (const m of msgs) {
        const who = m.role === "user" || m.role === "student" ? "**You**" : "**Buddy**";
        md.push(`${who}${m.intent ? ` _(${m.intent})_` : ""}: ${m.text.trim()}`, "");
      }
    }
  }
  md.push("---", "_Exported from Samjha. Citations link to your own notes._", "");
  const slug = title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 50) || "session";
  return { fileName: `samjha-${slug}-${root.created_at.slice(0, 10)}.md`, markdown: md.join("\n") };
}
