// Pure mastery + FSRS rules (no DB, no server-only) so they can be unit-tested with tsx.
import { createEmptyCard, fsrs, Rating, type Card, type CardInput, type Grade } from "ts-fsrs";
import type { AttemptKind, ClaimStatus, Mastery } from "../types";

const scheduler = fsrs({ enable_fuzz: false });

/** F6 grade mapping: wrong → Again, missing → Hard, covered after buddy → Good, covered independently → Easy. */
export function ratingFor(status: ClaimStatus, afterBuddy: boolean): Grade {
  if (status === "wrong") return Rating.Again;
  if (status === "missing") return Rating.Hard;
  return afterBuddy ? Rating.Good : Rating.Easy;
}

/**
 * F5 stored mastery after a graded attempt:
 * wrong/missing → red; covered on explain_back → green; covered with buddy help in that session → amber;
 * covered independently (explain/review/viva) → green.
 */
export function masteryAfterGrade(status: ClaimStatus, kind: AttemptKind, afterBuddy: boolean): Mastery {
  if (status !== "covered") return "red";
  if (kind === "explain_back") return "green";
  if (afterBuddy || kind === "exam_eve") return "amber";
  return "green";
}

/** Mastery computed on read: any non-red claim whose review is due turns amber. */
export function effectiveMastery(stored: Mastery | null | undefined, dueAt: string | null | undefined, now: Date = new Date()): Mastery {
  if (!stored || stored === "red") return "red";
  if (dueAt && new Date(dueAt).getTime() <= now.getTime()) return "amber";
  return stored;
}

/** Topic colour from the share of green claims. Accepts a fraction (0–1) or a percent (0–100). */
export function topicColour(greenShare: number): Mastery {
  const pct = greenShare > 1 ? greenShare : greenShare * 100;
  if (pct >= 90) return "green";
  if (pct >= 40) return "amber";
  return "red";
}

export interface TopicCounts { red: number; amber: number; green: number; total: number }

export function countMastery(ms: Mastery[]): TopicCounts {
  const c: TopicCounts = { red: 0, amber: 0, green: 0, total: ms.length };
  for (const m of ms) c[m]++;
  return c;
}

export const greenPercent = (c: TopicCounts) => (c.total ? Math.round((c.green / c.total) * 100) : 0);

/** Parse stored FSRS JSON (dates as ISO strings) or start a fresh card. */
export function parseCard(json: string | null | undefined, now: Date): Card | CardInput {
  if (json) {
    try {
      return JSON.parse(json) as CardInput;
    } catch {
      /* fall through */
    }
  }
  return createEmptyCard(now);
}

/** Apply one graded review to a card. Returns the new serialised state and its due date. */
export function scheduleCard(stateJson: string | null | undefined, status: ClaimStatus, afterBuddy: boolean, now: Date = new Date()) {
  const card = parseCard(stateJson, now);
  const { card: next } = scheduler.next(card, now, ratingFor(status, afterBuddy));
  return { stateJson: JSON.stringify(next), dueAt: next.due.toISOString(), card: next };
}

// ---------- study priority (F5 "what should I study now?", F7 ordering) ----------

export interface PriorityTopic {
  id: string;
  name: string;
  mastery: Mastery;
  greenPct: number;
  dependants: number;
  inExam: boolean;
  red?: number;
}

/** Red topics first, then by number of dependants, then in-exam flag, then amber; ties by lowest green share. */
export function rankTopics<T extends PriorityTopic>(topics: T[]): T[] {
  const rank = (m: Mastery) => (m === "red" ? 0 : m === "amber" ? 1 : 2);
  return topics
    .filter((t) => t.mastery !== "green")
    .sort(
      (a, b) =>
        rank(a.mastery) - rank(b.mastery) ||
        b.dependants - a.dependants ||
        Number(b.inExam) - Number(a.inExam) ||
        a.greenPct - b.greenPct ||
        a.name.localeCompare(b.name),
    );
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** Human reason, e.g. "Chain rule is red and 2 topics depend on it." */
export function reasonFor(t: PriorityTopic): string {
  const colour = t.mastery === "red" ? "red" : "amber, due for review";
  const parts = [`${t.name} is ${colour}`];
  if (t.dependants > 0) parts.push(`${plural(t.dependants, "topic")} depend${t.dependants === 1 ? "s" : ""} on it`);
  if (t.inExam) parts.push("you flagged it for the exam");
  let s = parts.length > 2 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts.join(" and ");
  if (parts.length === 1 && t.mastery === "red") s += t.greenPct > 0 ? `, only ${t.greenPct}% of it is solid` : ", you haven't nailed it yet";
  return s + ".";
}

// ---------- streaks ----------

/** YYYY-MM-DD for a date in a timezone (defaults to the server's local zone). */
export function dayKey(d: Date, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  }
}

function prevKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - 1));
  return t.toISOString().slice(0, 10);
}

/** Consecutive days with ≥1 explanation, ending today (or yesterday if nothing yet today). */
export function streakFromDates(dates: (Date | string)[], now: Date = new Date(), timeZone?: string): { days: number; today: boolean; longest: number } {
  const keys = new Set(dates.map((d) => dayKey(typeof d === "string" ? new Date(d) : d, timeZone)));
  const todayKey = dayKey(now, timeZone);
  const today = keys.has(todayKey);
  let cursor = today ? todayKey : prevKey(todayKey);
  let days = 0;
  while (keys.has(cursor)) {
    days++;
    cursor = prevKey(cursor);
  }
  const sorted = [...keys].sort();
  let longest = 0;
  let run = 0;
  let last = "";
  for (const k of sorted) {
    run = last && prevKey(k) === last ? run + 1 : 1;
    longest = Math.max(longest, run);
    last = k;
  }
  return { days, today, longest };
}

/** Session link for a short review of just the due claims. */
export const reviewHref = (topicId: string, claimIds: string[]) =>
  `/session/${encodeURIComponent(topicId)}?kind=review&claims=${claimIds.map(encodeURIComponent).join(",")}`;

/** About 2 minutes per due claim (spec F12: "3 concepts due, about 6 minutes"). */
export const reviewMinutes = (claims: number) => (claims ? Math.max(1, Math.round(claims * 2)) : 0);
