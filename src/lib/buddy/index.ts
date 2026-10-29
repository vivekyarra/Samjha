// Samjha buddy (spec F3, F4, §8.4): explains only the gaps of a graded attempt, in the student's style.
import "server-only";
import { all, get, run, newId, now } from "@/lib/db";
import { hasAI, aiStream } from "@/lib/ai";
import { retrieveChunks } from "@/lib/ingest";
import { getPrefs } from "@/lib/prefs";
import type { GradeResult, Prefs } from "@/lib/types";
import {
  fallbackText, streamText, wordLimit, gapsPerMessage, countWords, cite, frame,
  type BuddyCtx, type BuddyMode, type CoveredClaim, type Gap, type NoteBit,
} from "./fallback";

export type { BuddyMode } from "./fallback";

export interface StreamBuddyOpts {
  userId: string;
  topicId: string;
  attemptId: string;
  mode: BuddyMode;
  question?: string;
  oncePrefs?: Partial<Prefs>;
  differentAnalogy?: boolean;
}

interface Row { claim_id: string; status: string; evidence: string | null; correction: string | null; text: string; source_id: string | null; page: number | null; position: number }
interface Msg { role: string; text: string; intent: string | null }

const EXPLAINING: BuddyMode[] = ["gaps", "restyle", "continue", "shorter", "exam_eve"];

/** Encode which claims a buddy message explained, in buddy_messages.intent. */
export const encodeIntent = (mode: string, ids: string[]) => (ids.length ? `${mode}|${ids.join(",")}` : mode);
const idsOf = (intent: string | null) => (intent?.split("|")[1]?.split(",").filter(Boolean) ?? []);

async function notesFor(subjectId: string, claim: { text: string; source_id: string | null; page: number | null }): Promise<NoteBit[]> {
  const out: NoteBit[] = [];
  if (claim.source_id && claim.page) {
    for (const c of await all<{ source_id: string; page: number; text: string }>("SELECT source_id, page, text FROM chunks WHERE source_id=? AND page=? LIMIT 4", claim.source_id, claim.page))
      out.push({ sourceId: c.source_id, page: c.page, text: c.text });
  }
  try {
    for (const c of await retrieveChunks(subjectId, claim.text, 3)) {
      if (!out.some((o) => o.sourceId === c.source_id && o.page === c.page && o.text === c.text))
        out.push({ sourceId: c.source_id, page: c.page, text: c.text, fileName: c.file_name, score: c.score });
    }
  } catch {
    /* retrieval not available: page chunks are enough */
  }
  return out;
}

interface Loaded {
  ctx: BuddyCtx;
  transcript: string;
  result: GradeResult | null;
  history: Msg[];
  avoid: string[];
  sliceIds: string[];
}

async function load(o: StreamBuddyOpts): Promise<Loaded> {
  const topic = await get<{ id: string; name: string; subject_id: string }>("SELECT id, name, subject_id FROM topics WHERE id=?", o.topicId);
  if (!topic) throw new Response(JSON.stringify({ error: "Topic not found" }), { status: 404, headers: { "content-type": "application/json" } });
  const attempt = o.attemptId
    ? await get<{ id: string; user_id: string; transcript: string; result_json: string | null; parent_attempt_id: string | null }>("SELECT id, user_id, transcript, result_json, parent_attempt_id FROM attempts WHERE id=?", o.attemptId)
    : undefined;
  if (attempt && attempt.user_id !== o.userId) throw new Response(JSON.stringify({ error: "Not your attempt" }), { status: 403, headers: { "content-type": "application/json" } });

  const prefs: Prefs = { ...await getPrefs(o.userId, topic.subject_id), ...(o.oncePrefs ?? {}) };
  if (o.mode === "exam_eve") prefs.length = "very short";

  let rows: Row[] = attempt
    ? await all<Row>(
        `SELECT cr.claim_id, cr.status, cr.evidence, cr.correction, c.text, c.source_id, c.page, c.position
         FROM claim_results cr JOIN claims c ON c.id = cr.claim_id WHERE cr.attempt_id=? ORDER BY c.position`,
        attempt.id,
      )
    : [];
  if (!rows.length) {
    // no graded result (e.g. exam-eve straight from the heatmap): treat red/amber claims as missing
    rows = await all<Row>(
      `SELECT c.id AS claim_id, 'missing' AS status, '' AS evidence, '' AS correction, c.text, c.source_id, c.page, c.position
       FROM claims c LEFT JOIN claim_cards k ON k.claim_id=c.id AND k.user_id=? WHERE c.topic_id=? AND IFNULL(k.mastery,'red') <> 'green' ORDER BY c.position`,
      o.userId,
      o.topicId,
    );
  }
  let result: GradeResult | null = null;
  try {
    result = attempt?.result_json ? (JSON.parse(attempt.result_json) as GradeResult) : null;
  } catch {
    result = null;
  }

  const toGap = async (r: Row): Promise<Gap> => ({
    claimId: r.claim_id, text: r.text, status: r.status === "wrong" ? "wrong" : "missing",
    evidence: r.evidence ?? "", correction: r.correction ?? "", sourceId: r.source_id, page: r.page,
    notes: await notesFor(topic.subject_id, r),
  });
  const covered: CoveredClaim[] = rows.filter((r) => r.status === "covered").map((r) => ({ claimId: r.claim_id, text: r.text, evidence: r.evidence ?? "" }));
  let gaps = await Promise.all([...rows.filter((r) => r.status === "wrong"), ...rows.filter((r) => r.status === "missing")].map(toGap));

  let scopeNote: string | undefined;
  if (prefs.scope === "only what I got wrong") {
    if (gaps.some((g) => g.status === "wrong")) gaps = gaps.filter((g) => g.status === "wrong");
    else scopeNote = "only_wrong_none";
  }

  // history across this attempt and its parent (explain_back continues the same session)
  const attemptIds = [attempt?.id, attempt?.parent_attempt_id].filter((x): x is string => !!x);
  const history = attemptIds.length
    ? await all<Msg>(`SELECT role, text, intent FROM buddy_messages WHERE attempt_id IN (${attemptIds.map(() => "?").join(",")}) ORDER BY created_at`, ...attemptIds)
    : [];
  const buddyMsgs = history.filter((m) => m.role === "buddy");
  const ownMsgs = attempt ? await all<Msg>("SELECT role, text, intent FROM buddy_messages WHERE attempt_id=? AND role='buddy' ORDER BY created_at", attempt.id) : [];
  const lastExplain = [...ownMsgs].reverse().find((m) => EXPLAINING.includes((m.intent?.split("|")[0] ?? "") as BuddyMode));
  const lastIds = idsOf(lastExplain?.intent ?? null);
  const done = new Set(ownMsgs.filter((m) => /^(gaps|continue|restyle)\|/.test(m.intent ?? "")).flatMap((m) => idsOf(m.intent)));

  const per = gapsPerMessage(prefs.length);
  let slice: Gap[];
  if (o.mode === "continue") slice = gaps.filter((g) => !done.has(g.claimId)).slice(0, per);
  else if (o.mode === "restyle" || o.mode === "shorter") {
    slice = lastIds.length ? gaps.filter((g) => lastIds.includes(g.claimId)) : gaps.slice(0, per);
    if (!slice.length) slice = gaps.slice(0, per);
  } else if (o.mode === "exam_eve") slice = gaps;
  else if (o.mode === "gaps") slice = gaps.slice(0, per);
  else slice = [];
  const after = new Set([...done, ...slice.map((g) => g.claimId)]);
  const remaining = o.mode === "gaps" ? Math.max(0, gaps.length - slice.length) : gaps.filter((g) => !after.has(g.claimId)).length;
  const current = gaps.find((g) => g.claimId === lastIds[lastIds.length - 1]) ?? gaps.find((g) => !done.has(g.claimId)) ?? gaps[0];

  let questionNotes: NoteBit[] | undefined;
  if (o.mode === "question" && o.question) {
    try {
      questionNotes = (await retrieveChunks(topic.subject_id, `${o.question} ${topic.name}`, 4)).map((c) => ({ sourceId: c.source_id, page: c.page, text: c.text, fileName: c.file_name, score: c.score }));
    } catch {
      questionNotes = current?.notes ?? [];
    }
  }

  const avoid = buddyMsgs
    .flatMap((m) => m.text.split(/(?<=[.!?])\s+/))
    .filter((s) => /\b(think of|imagine|picture|like a|it's like|socho|jaise|सोचो)\b/i.test(s))
    .map((s) => s.slice(0, 160));

  const ctx: BuddyCtx = {
    mode: o.mode,
    topicName: topic.name,
    prefs,
    slice,
    gaps,
    covered,
    remaining,
    current,
    question: o.question,
    questionNotes,
    prevText: lastExplain?.text,
    history: buddyMsgs.map((m) => m.text),
    differentAnalogy: o.differentAnalogy || o.mode === "stuck",
    scopeNote,
  };
  const sliceIds = o.mode === "why" || o.mode === "example" || o.mode === "stuck" || o.mode === "question" ? (current ? [current.claimId] : []) : slice.map((g) => g.claimId);
  return { ctx, transcript: attempt?.transcript ?? "", result, history, avoid, sliceIds };
}

// ---------- Claude prompt (§8.4) ----------
function systemPrompt(p: Prefs, mode: BuddyMode, avoid: string[], differentAnalogy: boolean): string {
  const limit = wordLimit(p.length);
  const F = frame(p);
  const lang =
    p.language === "Hinglish"
      ? "Speak Hinglish: casual Hindi-English mix in Roman script, the way Indian college friends talk (e.g. \"Dekho, yahan gradient ulta direction mein jaata hai\"). Keep technical terms in English."
      : p.language === "Hindi"
        ? "Speak simple Hindi in Devanagari script. Keep technical terms in English."
        : `Speak ${p.language || "English"}.`;
  const level = {
    "like I'm 12": "Explain like the student is 12: everyday words, no jargon without a one-line meaning, tiny sentences.",
    beginner: "Assume a beginner: define each term the first time you use it.",
    "exam-level": "Exam-level: precise wording the student could write in an exam answer.",
    "interview-level": "Interview-level: crisp, confident phrasing plus one practical example, the way you'd answer an interviewer.",
  }[p.level] ?? `Level: ${p.level}.`;
  const format = {
    conversational: "Format: conversational short paragraphs, like talking.",
    "bullet points": "Format: bullet points (markdown '- '), one idea per bullet.",
    "step-by-step": "Format: numbered steps.",
    "formula-first": "Format: lead each point with the formula/equation (if the notes have one), then explain it.",
  }[p.format] ?? `Format: ${p.format}.`;
  const tone = {
    "chill friend": "Tone: chill, warm friend. Casual, encouraging, no lecturing.",
    "strict senior": "Tone: strict senior. Direct, no fluff, points out what costs marks, but never insulting.",
    "hype coach": "Tone: hype coach. High energy, celebratory, motivating, short punchy lines.",
  }[p.tone] ?? `Tone: ${p.tone}.`;
  const scope = {
    "only my gaps": "Scope: only the gaps listed.",
    "only what I got wrong": "Scope: only the WRONG claims (skip missing ones unless nothing was wrong).",
    "gaps + one example": "Scope: the gaps, plus ONE short concrete example at the end.",
    "full topic": "Scope: give a one-line recap of the covered claims first (one line each, no re-teaching), then the gaps.",
    "just the formula": "Scope: just the formula / key equation for each gap, one line of meaning each. No analogies.",
    "example question": "Scope: instead of explaining, ask ONE practice question per gap (max 2) that tests it. Do not give answers.",
  }[p.scope] ?? `Scope: ${p.scope}.`;
  const analogy = p.analogy
    ? `Analogies come from this world: ${p.analogy}. Build them on something the student already said correctly.`
    : "Pick an analogy from everyday Indian student life if it helps, built on something the student already said correctly.";

  return [
    "You are Samjha, the student's study buddy: a smart friend who explains only what they got wrong or missed, grounded in THEIR notes.",
    "Rules:",
    "- Explain ONLY the gaps given to you, wrong ones first, then missing ones. Never re-explain covered claims (except a one-line recap if scope says full topic).",
    "- Every fact must come from the claims or note excerpts provided. Anything else must be labelled exactly \"(extra, not in your notes)\".",
    "- After each fixed claim, put its page citation exactly as given, as a markdown link like [p.4](/sources/ID?page=4). Never read citations aloud or explain them.",
    `- Stay under ${limit} words per gap (${p.length}). If you would go over, stop and ask "${F.goOn(1).split("?")[0]}?" instead of continuing.`,
    "- No headings, no preamble, no 'Great question'. Plain text plus the markdown links (and bullets/numbers if the format says so).",
    `- ${lang}`,
    `- ${level}`,
    `- ${format}`,
    `- ${tone}`,
    `- ${scope}`,
    `- ${analogy}`,
    differentAnalogy || avoid.length
      ? `- ${differentAnalogy ? "Use a DIFFERENT analogy from before. " : ""}Do not reuse these earlier analogies:\n${avoid.slice(-6).map((a) => `  * ${a}`).join("\n") || "  (none)"}`
      : "",
    mode === "exam_eve"
      ? "- Exam-eve mode: the shortest possible version of each gap, 1-2 lines each, no opener, no analogies, no closing line."
      : `- End with exactly the line given in the task as the closing line.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function userPrompt(l: Loaded): string {
  const c = l.ctx;
  const F = frame(c.prefs);
  const gapLine = (g: Gap) =>
    `- [${g.status.toUpperCase()}] claim: "${g.text}" cite: ${cite(g.sourceId, g.page) || "(no page)"}` +
    (g.status === "wrong" ? `\n  student said: "${g.evidence}"\n  correction: ${g.correction}` : "") +
    (g.notes.length ? `\n  note excerpts:\n${g.notes.slice(0, 3).map((n) => `    ${cite(n.sourceId, n.page)} ${n.text.slice(0, 600)}`).join("\n")}` : "");
  const covered = c.covered.map((k) => `- "${k.text}"${k.evidence ? ` (student said: "${k.evidence}")` : ""}`).join("\n") || "(nothing yet)";
  const closing = c.remaining > 0 ? F.goOn(c.remaining) : F.back;
  const convo = l.history.slice(-8).map((m) => `${m.role === "buddy" ? "Buddy" : "Student"}: ${m.text.slice(0, 700)}`).join("\n");
  const cur = c.current;

  const task: Record<BuddyMode, string> = {
    gaps: `Open with ONE line about what they got right (use the covered list; if empty, one encouraging line). Then explain these gaps in order:\n${c.slice.map(gapLine).join("\n")}\nClosing line: "${closing}"`,
    restyle: `The student changed their style. Re-explain the same gaps in the NEW style (one short opener line):\n${c.slice.map(gapLine).join("\n")}\nClosing line: "${closing}"`,
    continue: `Continue where you stopped (no opener, no recap). Explain these next gaps:\n${c.slice.map(gapLine).join("\n") || "(no gaps left: say all gaps are covered)"}\nClosing line: "${closing}"`,
    shorter: `Re-explain your last answer in HALF the words (at most ${Math.max(20, Math.floor(countWords(c.prevText ?? "") / 2))} words total), keeping citations. Last answer:\n"""${c.prevText ?? ""}"""\nGaps it covered:\n${c.slice.map(gapLine).join("\n")}\nClosing line: "${closing}"`,
    why: `The student asked "${c.question || "wait, why?"}" about the current point. Explain the REASON behind it (from the notes), briefly, with one analogy.\nCurrent point:\n${cur ? gapLine(cur) : "(none)"}\nClosing line: "${c.remaining > 0 ? F.goOn(c.remaining) : F.back}"`,
    example: `The student asked for an example. Give ONE concrete worked example of the current point (prefer an example from the notes; otherwise label it "(extra, not in your notes)").\nCurrent point:\n${cur ? gapLine(cur) : "(none)"}\nClosing line: "${c.remaining > 0 ? F.goOn(c.remaining) : F.back}"`,
    stuck: `The student said "I still don't get it". Try a completely DIFFERENT, simpler analogy and simpler words for the current point. Then add one line: if it still feels fuzzy, the gap might be in an earlier topic this one builds on.\nCurrent point:\n${cur ? gapLine(cur) : "(none)"}\nClosing line: "${F.back}"`,
    question: `The student interrupted with a question: "${c.question ?? ""}". Answer it in context, briefly, from the notes below (cite pages; label anything else "(extra, not in your notes)"). Then return to the remaining gaps.\nNotes:\n${(c.questionNotes ?? []).map((n) => `${cite(n.sourceId, n.page)} ${n.text.slice(0, 600)}`).join("\n") || "(nothing relevant found)"}\nClosing line: "${c.remaining > 0 || c.gaps.length ? F.backToGaps : F.back}"`,
    exam_eve: `Exam tomorrow. Give the essential fix for each gap, shortest form:\n${c.slice.map(gapLine).join("\n")}`,
  };
  return [
    `Topic: ${c.topicName}`,
    l.transcript ? `Student's explanation:\n"""${l.transcript.slice(0, 3000)}"""` : "",
    `Covered correctly (do NOT re-explain):\n${covered}`,
    l.result?.strengths?.length ? `Strengths noted by the grader: ${l.result.strengths.join("; ")}` : "",
    c.scopeNote === "only_wrong_none" ? "Note: nothing was wrong, so explain the missing ones and say so in one line." : "",
    convo ? `Conversation so far:\n${convo}` : "",
    `Task (${c.mode}):\n${task[c.mode]}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function saveBuddy(attemptId: string, text: string, intent: string) {
  if (!attemptId || !text.trim()) return;
  try {
    await run("INSERT INTO buddy_messages (id,attempt_id,role,text,intent,created_at) VALUES (?,?,?,?,?,?)", newId("b_"), attemptId, "buddy", text.trim(), intent, now());
  } catch {
    /* attempt may not exist (e.g. exam-eve without an attempt) */
  }
}

/** Save the student's side of the buddy conversation. */
export async function saveStudentMessage(attemptId: string, text: string, intent: string) {
  if (!attemptId) return;
  try {
    await run("INSERT INTO buddy_messages (id,attempt_id,role,text,intent,created_at) VALUES (?,?,?,?,?,?)", newId("b_"), attemptId, "student", text.trim() || `(${intent})`, intent, now());
  } catch {
    /* ignore */
  }
}

/** Streams the buddy reply (§8.4). Saves the final buddy message (with the claims it explained) to buddy_messages. */
export async function* streamBuddy(opts: StreamBuddyOpts): AsyncGenerator<string> {
  const l = await load(opts);
  const intent = encodeIntent(opts.mode, l.sliceIds);
  let text = "";
  const noWork = ["gaps", "restyle", "continue", "shorter", "exam_eve"].includes(opts.mode) && !l.ctx.slice.length;

  if (hasAI() && !noWork) {
    const limit = wordLimit(l.ctx.prefs.length);
    const cap = Math.round(limit * Math.max(1, l.ctx.slice.length) * 1.3) + 60;
    try {
      const stream = aiStream({
        system: systemPrompt(l.ctx.prefs, opts.mode, l.avoid, !!l.ctx.differentAnalogy),
        user: userPrompt(l),
        model: ["why", "example", "shorter", "question", "exam_eve"].includes(opts.mode) ? "fast" : "strong",
        maxTokens: Math.min(2000, Math.round(cap * 2.2)),
      });
      for await (const d of stream) {
        text += d;
        yield d;
        if (countWords(text) > cap) {
          const tail = `… ${frame(l.ctx.prefs).goOn(Math.max(1, l.ctx.remaining))}`;
          text += tail;
          yield tail;
          break;
        }
      }
      await saveBuddy(opts.attemptId, text, intent);
      return;
    } catch {
      // provider busy or failed (possibly mid-stream): finish with the built-in engine
      if (text) {
        const rest = `\n\n${fallbackText(l.ctx)}`;
        for await (const piece of streamText(rest)) yield piece;
        await saveBuddy(opts.attemptId, text + rest, intent);
        return;
      }
    }
  }

  text = fallbackText(l.ctx);
  for await (const piece of streamText(text)) yield piece;
  await saveBuddy(opts.attemptId, text, intent);
}
