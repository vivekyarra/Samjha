// Samjha preferences (spec F4). Global prefs have subject_id NULL; subject prefs override them in that subject.
import "server-only";
import { z } from "zod";
import { all, get, run, tx, newId, now, logEvent } from "@/lib/db";
import { hasAI, aiJSON } from "@/lib/ai";
import { canAccessSubject } from "@/lib/auth";
import { PREF_DEFAULTS, type PrefKey, type Prefs } from "@/lib/types";
import { parseStyleCommands, resolveRelative, confirmationFor, type StyleCommand } from "./parse";

export { parseStyleCommand, parseStyleCommands, confirmationFor, prefLabel } from "./parse";
export type { StyleCommand } from "./parse";

export const PREF_KEYS = Object.keys(PREF_DEFAULTS) as PrefKey[];
export const isPrefKey = (k: unknown): k is PrefKey => typeof k === "string" && (PREF_KEYS as string[]).includes(k);

export interface PrefRow { id: string; key: PrefKey; value: string; subjectId: string | null; subjectName: string | null; updatedAt: string }

/** Effective prefs: defaults <- global <- subject. */
export async function getPrefs(userId: string, subjectId?: string | null): Promise<Prefs> {
  const rows = await all<{ key: string; value: string; subject_id: string | null }>(
    "SELECT key, value, subject_id FROM preferences WHERE user_id=? AND (subject_id IS NULL OR subject_id=?)",
    userId,
    subjectId ?? "",
  );
  const out: Prefs = { ...PREF_DEFAULTS };
  for (const r of rows) if (!r.subject_id && isPrefKey(r.key)) out[r.key] = r.value;
  for (const r of rows) if (r.subject_id && isPrefKey(r.key)) out[r.key] = r.value;
  return out;
}

export async function setPref(userId: string, key: PrefKey, value: string, subjectId?: string | null) {
  const v = value.trim().slice(0, 60);
  await tx(async () => {
    await run("DELETE FROM preferences WHERE user_id=? AND IFNULL(subject_id,'')=? AND key=?", userId, subjectId ?? "", key);
    await run("INSERT INTO preferences (id,user_id,subject_id,key,value,updated_at) VALUES (?,?,?,?,?,?)", newId("p_"), userId, subjectId ?? null, key, v, now());
  });
}

export async function removePref(userId: string, key: PrefKey, subjectId?: string | null) {
  await run("DELETE FROM preferences WHERE user_id=? AND IFNULL(subject_id,'')=? AND key=?", userId, subjectId ?? "", key);
}

export async function resetPrefs(userId: string) {
  await run("DELETE FROM preferences WHERE user_id=?", userId);
}

export async function listPrefs(userId: string): Promise<PrefRow[]> {
  return (await all<{ id: string; key: string; value: string; subject_id: string | null; name: string | null; updated_at: string }>(
    `SELECT p.id, p.key, p.value, p.subject_id, s.name, p.updated_at FROM preferences p
     LEFT JOIN subjects s ON s.id = p.subject_id WHERE p.user_id=? ORDER BY p.subject_id IS NOT NULL, s.name, p.key`,
    userId,
  ))
    .filter((r) => isPrefKey(r.key))
    .map((r) => ({ id: r.id, key: r.key as PrefKey, value: r.value, subjectId: r.subject_id, subjectName: r.name, updatedAt: r.updated_at }));
}

/** Fuzzy-match a spoken subject name against subjects the user can access. */
export async function resolveSubjectByName(userId: string, name: string): Promise<{ id: string; name: string } | null> {
  const subs = await all<{ id: string; name: string }>(
    "SELECT s.id, s.name FROM subjects s JOIN subject_members m ON m.subject_id=s.id WHERE m.user_id=?",
    userId,
  );
  const q = name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!q) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const alias: Record<string, string> = { maths: "mathematics", math: "mathematics", bio: "biology", chem: "chemistry", phy: "physics", ml: "machine learning", cs: "computer science", dsa: "data structures" };
  const qa = alias[q] ?? q;
  let best: { id: string; name: string; score: number } | null = null;
  for (const s of subs) {
    const n = norm(s.name);
    let score = 0;
    if (n === q || n === qa) score = 100;
    else if (n.includes(qa) || n.includes(q)) score = 80;
    else if (q.includes(n)) score = 70;
    else {
      const qw = new Set(qa.split(" "));
      const nw = n.split(" ");
      const hit = nw.filter((w) => qw.has(w) || [...qw].some((x) => x.length > 3 && (w.startsWith(x) || x.startsWith(w)))).length;
      score = hit ? (hit / Math.max(nw.length, qw.size)) * 60 : 0;
      const initials = nw.map((w) => w[0]).join("");
      if (initials.length > 1 && initials === q.replace(/ /g, "")) score = Math.max(score, 75);
    }
    if (score >= 30 && (!best || score > best.score)) best = { id: s.id, name: s.name, score };
  }
  return best ? { id: best.id, name: best.name } : null;
}

export interface CommandResult {
  applied: boolean;
  confirmation: string;
  suggestion?: string;
  /** Prefs to pass as `oncePrefs` to the next /api/buddy call ("just this time…", "shorter"). */
  oncePrefs?: Partial<Prefs>;
  commands: StyleCommand[];
  /** Effective prefs after the change (for the current subject). */
  prefs: Prefs;
}

const aiSchema = z.object({
  commands: z.array(
    z.object({
      key: z.enum(["language", "analogy", "length", "level", "format", "tone", "scope"]),
      value: z.string(),
      persist: z.enum(["global", "subject", "once"]),
      remove: z.boolean().optional(),
      reset: z.boolean().optional(),
      subjectName: z.string().optional(),
    }),
  ),
});

async function aiParse(text: string): Promise<StyleCommand[]> {
  if (!hasAI()) return [];
  try {
    const r = await aiJSON(
      {
        model: "fast",
        cache: true,
        maxTokens: 300,
        system:
          `You turn a student's spoken style request for a study buddy into preference changes. Keys and typical values: ` +
          `language (English, Hinglish, Hindi, …), analogy (free text world like cricket, gaming), length (very short, short, normal, detailed), ` +
          `level (like I'm 12, beginner, exam-level, interview-level), format (conversational, bullet points, step-by-step, formula-first), ` +
          `tone (chill friend, strict senior, hype coach), scope (only my gaps, only what I got wrong, gaps + one example, full topic, just the formula, example question). ` +
          `persist: "once" if they say just this time; "subject" if they name a subject (put it in subjectName); else "global". remove:true to drop a preference, reset:true to clear all. ` +
          `If the text is not a style request, return {"commands":[]}.`,
        user: text,
      },
      aiSchema,
    );
    return r.commands;
  } catch {
    return [];
  }
}

/** Was "shorter" asked 3 times in a row (no other style command in between, no suggestion since)? */
async function shorterStreak(userId: string): Promise<boolean> {
  const rows = await all<{ name: string }>(
    "SELECT name FROM events WHERE user_id=? AND name IN ('style_shorter','style_command','style_shorter_suggested') ORDER BY created_at DESC LIMIT 3",
    userId,
  );
  return rows.length === 3 && rows.every((r) => r.name === "style_shorter");
}

export const SHORTER_SUGGESTION = "Want me to keep things shorter from now on?";

/** Record a "shorter" request (command or buddy interrupt); returns the suggestion once the streak hits 3. Never saves. */
export async function noteShorter(userId: string): Promise<string | undefined> {
  await logEvent(userId, "style_shorter");
  if (!await shorterStreak(userId)) return undefined;
  await logEvent(userId, "style_shorter_suggested");
  return SHORTER_SUGGESTION;
}

/** Parse + apply a spoken style command (POST /api/prefs/command). */
export async function applyStyleCommand(userId: string, text: string, subjectId?: string | null): Promise<CommandResult> {
  let cmds = parseStyleCommands(text);
  if (!cmds.length) cmds = await aiParse(text);
  const current = await getPrefs(userId, subjectId);
  if (!cmds.length) return { applied: false, confirmation: confirmationFor([]), commands: [], prefs: current };

  if (cmds.some((c) => c.reset)) {
    await resetPrefs(userId);
    await logEvent(userId, "style_command", { reset: true });
    return { applied: true, confirmation: confirmationFor(cmds), commands: cmds, prefs: await getPrefs(userId, subjectId) };
  }

  // resolve the subject for subject-scoped commands
  let target: { id: string; name: string } | null = null;
  const named = cmds.find((c) => c.persist === "subject" && c.subjectName)?.subjectName;
  if (cmds.some((c) => c.persist === "subject")) {
    if (named) target = await resolveSubjectByName(userId, named);
    else if (subjectId) target = await get<{ id: string; name: string }>("SELECT id, name FROM subjects WHERE id=?", subjectId) ?? null;
    if (!target || !await canAccessSubject(userId, target.id)) {
      return {
        applied: false,
        confirmation: named ? `I couldn't find a subject called ${named}. Say it the way it's named on your heatmap.` : "Open a subject first, then tell me the style for it.",
        commands: cmds,
        prefs: current,
      };
    }
  }

  const resolved: StyleCommand[] = [];
  const oncePrefs: Partial<Prefs> = {};
  let suggestion: string | undefined;
  let removedNothing = false;
  for (const c of cmds) {
    const scopeId = c.persist === "subject" ? target!.id : null;
    let value = c.value;
    if (c.key === "length" && c.relative) value = resolveRelative(c.persist === "once" ? current.length : (await getPrefs(userId, scopeId)).length, c.relative);
    if (c.remove) {
      if (c.key === "analogy" && c.value) {
        const saved = await get<{ value: string }>("SELECT value FROM preferences WHERE user_id=? AND IFNULL(subject_id,'')=? AND key='analogy'", userId, scopeId ?? "");
        if (!saved || !saved.value.toLowerCase().includes(c.value.toLowerCase())) {
          removedNothing = true;
          oncePrefs.analogy = current.analogy.toLowerCase().includes(c.value.toLowerCase()) ? "" : current.analogy;
          continue;
        }
      }
      await removePref(userId, c.key, scopeId);
    } else if (c.persist === "once") {
      oncePrefs[c.key] = value;
    } else {
      await setPref(userId, c.key, value, scopeId);
    }
    resolved.push({ ...c, value });
  }

  const isShorter = cmds.length === 1 && cmds[0].key === "length" && (cmds[0].relative ?? 0) < 0 && cmds[0].persist === "once";
  if (isShorter) suggestion = await noteShorter(userId);
  else await logEvent(userId, "style_command", { cmds: resolved.map((c) => `${c.key}=${c.value}`) });

  const confirmation =
    removedNothing && !resolved.length
      ? `You don't have ${cmds[0].value} analogies saved, but I'll skip them.`
      : isShorter
        ? `Sure, ${resolved[0].value === "very short" ? "keeping it really short" : "shorter"}.`
        : confirmationFor(resolved, target?.name);
  return {
    applied: resolved.length > 0 || removedNothing,
    confirmation,
    suggestion,
    oncePrefs: Object.keys(oncePrefs).length ? oncePrefs : undefined,
    commands: resolved,
    prefs: { ...await getPrefs(userId, subjectId), ...oncePrefs },
  };
}
