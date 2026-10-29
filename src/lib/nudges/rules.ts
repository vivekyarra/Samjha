// Pure nudge decision logic (no DB, no server-only) so it can be unit tested with tsx.
import type { NudgeSettings } from "@/lib/settings/schema";

export const MINUTES_PER_CONCEPT = 2;
const HOUR = 3600_000;

/** Minimum gap between regular nudges. Slightly under the nominal period so an hourly cron doesn't drift later. */
export const FREQUENCY_GAP_MS: Record<NudgeSettings["frequency"], number> = {
  daily: 20 * HOUR,
  every2days: 44 * HOUR,
  weekly: 6.5 * 24 * HOUR,
  off: Infinity,
};

export interface ExamInfo { subjectId: string; name: string; examDate: string }

export interface NudgeInput {
  now: Date;
  nudges: NudgeSettings;
  /** Claims due today (or overdue). */
  dueCount: number;
  /** When the last regular (non-test) nudge went out, ISO; null if never. */
  lastSentAt: string | null;
  exams: ExamInfo[];
  /** Subject ids that already got an exam-eve nudge in the last 24h. */
  examEveSentFor: string[];
  /** At least one channel is enabled and usable. */
  hasChannel: boolean;
}

export interface NudgeDecision {
  shouldSend: boolean;
  reason: string;
  kind: "due" | "exam_week" | "exam_eve" | null;
  body: string;
  /** In-app target the open link redirects to (the open-tracking wrapper is added by the caller). */
  target: string;
  subjectId?: string;
}

export interface LocalTime { date: string; hour: number; minute: number; tz: string }

export function validTimezone(tz: string | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** Wall-clock date (YYYY-MM-DD), hour and minute of `now` in `tz`. */
export function localTime(now: Date, tz: string | undefined): LocalTime {
  const zone = validTimezone(tz);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "00";
  return { date: `${p("year")}-${p("month")}-${p("day")}`, hour: Number(p("hour")) % 24, minute: Number(p("minute")), tz: zone };
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Is local HH:MM inside the quiet window? Handles overnight windows like 22:00–08:00. Equal start/end = no quiet hours. */
export function inQuietHours(hour: number, minute: number, quietStart: string, quietEnd: string): boolean {
  const t = hour * 60 + minute;
  const s = toMin(quietStart);
  const e = toMin(quietEnd);
  if (s === e) return false;
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/** Whole days from local date `fromDate` to `examDate` (both YYYY-MM-DD; examDate may be a full ISO string). */
export function daysUntil(fromDate: string, examDate: string): number {
  const a = Date.UTC(+fromDate.slice(0, 4), +fromDate.slice(5, 7) - 1, +fromDate.slice(8, 10));
  const d = examDate.slice(0, 10);
  const b = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

export function dueBody(dueCount: number): string {
  const mins = Math.max(MINUTES_PER_CONCEPT, dueCount * MINUTES_PER_CONCEPT);
  return `${dueCount} concept${dueCount === 1 ? "" : "s"} due, about ${mins} minute${mins === 1 ? "" : "s"}.`;
}

const no = (reason: string): NudgeDecision => ({ shouldSend: false, reason, kind: null, body: "", target: "" });

/** Hour (local) from which the exam-eve offer may go out on the day before the exam. */
export const EXAM_EVE_FROM_HOUR = 17;

export function decideNudge(input: NudgeInput): NudgeDecision {
  const { nudges, now } = input;
  if (nudges.frequency === "off") return no("Nudges are off");
  if (!input.hasChannel) return no("No channel enabled (turn on email or WhatsApp)");
  const lt = localTime(now, nudges.timezone);
  if (inQuietHours(lt.hour, lt.minute, nudges.quietStart, nudges.quietEnd)) {
    return no(`Quiet hours (${nudges.quietStart}–${nudges.quietEnd}, ${lt.tz})`);
  }

  const upcoming = input.exams
    .filter((e) => /^\d{4}-\d{2}-\d{2}/.test(e.examDate))
    .map((e) => ({ ...e, days: daysUntil(lt.date, e.examDate) }))
    .filter((e) => e.days >= 0 && e.days <= 7)
    .sort((a, b) => a.days - b.days);

  // Night before the exam: offer exam-eve mode (independent of the regular cadence, once per subject).
  const eve = upcoming.find((e) => e.days === 1 && !input.examEveSentFor.includes(e.subjectId));
  if (eve && lt.hour >= EXAM_EVE_FROM_HOUR) {
    const due = input.dueCount > 0 ? ` ${dueBody(input.dueCount)}` : "";
    return {
      shouldSend: true,
      reason: `${eve.name} exam is tomorrow`,
      kind: "exam_eve",
      body: `${eve.name} exam tomorrow. Want a quick exam-eve session on your weakest topics?${due}`,
      target: `/exam-eve?subjectId=${encodeURIComponent(eve.subjectId)}`,
      subjectId: eve.subjectId,
    };
  }

  const examWeek = upcoming.length > 0;
  const gap = examWeek ? FREQUENCY_GAP_MS.daily : FREQUENCY_GAP_MS[nudges.frequency];
  if (input.lastSentAt) {
    const since = now.getTime() - new Date(input.lastSentAt).getTime();
    if (since < gap) return no(`Already nudged ${Math.round(since / HOUR)}h ago (${examWeek ? "daily in exam week" : nudges.frequency})`);
  }

  if (examWeek) {
    const e = upcoming[0];
    const when = e.days === 0 ? "today" : e.days === 1 ? "tomorrow" : `in ${e.days} days`;
    const body =
      input.dueCount > 0
        ? `${e.name} exam ${when}. ${dueBody(input.dueCount)}`
        : `${e.name} exam ${when}. Explain one topic today to stay sharp, about ${MINUTES_PER_CONCEPT * 2} minutes.`;
    return { shouldSend: true, reason: `Exam week: ${e.name} ${when}`, kind: "exam_week", body, target: "/review", subjectId: e.subjectId };
  }

  if (input.dueCount <= 0) return no("Nothing due today");
  return { shouldSend: true, reason: `${input.dueCount} due`, kind: "due", body: dueBody(input.dueCount), target: "/review" };
}
