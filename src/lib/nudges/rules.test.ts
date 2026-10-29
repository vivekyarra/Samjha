// Run: npx tsx src/lib/nudges/rules.test.ts
import assert from "node:assert/strict";
import { decideNudge, inQuietHours, localTime, daysUntil, dueBody, type NudgeInput } from "./rules";

const base = (over: Partial<NudgeInput> = {}): NudgeInput => ({
  now: new Date("2026-10-28T06:00:00Z"), // 11:30 in Asia/Kolkata
  nudges: { email: true, whatsapp: false, frequency: "daily", quietStart: "22:00", quietEnd: "08:00", timezone: "Asia/Kolkata" },
  dueCount: 3,
  lastSentAt: null,
  exams: [],
  examEveSentFor: [],
  hasChannel: true,
  ...over,
});
const at = (iso: string) => new Date(iso);
let n = 0;
const test = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log("ok -", name);
};

test("quiet hours, overnight window", () => {
  assert.equal(inQuietHours(23, 0, "22:00", "08:00"), true);
  assert.equal(inQuietHours(2, 30, "22:00", "08:00"), true);
  assert.equal(inQuietHours(8, 0, "22:00", "08:00"), false);
  assert.equal(inQuietHours(21, 59, "22:00", "08:00"), false);
});
test("quiet hours, same-day window and disabled", () => {
  assert.equal(inQuietHours(13, 0, "12:00", "14:00"), true);
  assert.equal(inQuietHours(14, 0, "12:00", "14:00"), false);
  assert.equal(inQuietHours(3, 0, "00:00", "00:00"), false);
});
test("local time in timezone, bad tz falls back to UTC", () => {
  assert.deepEqual(localTime(at("2026-10-28T20:00:00Z"), "Asia/Kolkata"), { date: "2026-10-29", hour: 1, minute: 30, tz: "Asia/Kolkata" });
  assert.equal(localTime(at("2026-10-28T20:00:00Z"), "Not/AZone").tz, "UTC");
});
test("daysUntil", () => {
  assert.equal(daysUntil("2026-10-28", "2026-11-04"), 7);
  assert.equal(daysUntil("2026-10-28", "2026-10-29T00:00:00.000Z"), 1);
  assert.equal(daysUntil("2026-10-28", "2026-10-27"), -1);
});
test("body copy matches spec", () => {
  assert.equal(dueBody(3), "3 concepts due, about 6 minutes.");
  assert.equal(dueBody(1), "1 concept due, about 2 minutes.");
});
test("sends daily nudge with due count", () => {
  const d = decideNudge(base());
  assert.equal(d.shouldSend, true);
  assert.equal(d.kind, "due");
  assert.equal(d.body, "3 concepts due, about 6 minutes.");
  assert.equal(d.target, "/review");
});
test("respects quiet hours in user's timezone", () => {
  // 23:30 IST
  const d = decideNudge(base({ now: at("2026-10-28T18:00:00Z") }));
  assert.equal(d.shouldSend, false);
  assert.match(d.reason, /Quiet hours/);
  // same instant is 18:00 UTC: not quiet for a UTC user
  assert.equal(decideNudge(base({ now: at("2026-10-28T18:00:00Z"), nudges: { ...base().nudges, timezone: "UTC" } })).shouldSend, true);
});
test("frequency off / no channel / nothing due", () => {
  assert.equal(decideNudge(base({ nudges: { ...base().nudges, frequency: "off" } })).shouldSend, false);
  assert.equal(decideNudge(base({ hasChannel: false })).shouldSend, false);
  assert.equal(decideNudge(base({ dueCount: 0 })).shouldSend, false);
});
test("frequency gaps", () => {
  const now = base().now.getTime();
  const ago = (h: number) => new Date(now - h * 3600_000).toISOString();
  assert.equal(decideNudge(base({ lastSentAt: ago(10) })).shouldSend, false);
  assert.equal(decideNudge(base({ lastSentAt: ago(23) })).shouldSend, true);
  const e2 = { ...base().nudges, frequency: "every2days" as const };
  assert.equal(decideNudge(base({ nudges: e2, lastSentAt: ago(30) })).shouldSend, false);
  assert.equal(decideNudge(base({ nudges: e2, lastSentAt: ago(47) })).shouldSend, true);
  const wk = { ...base().nudges, frequency: "weekly" as const };
  assert.equal(decideNudge(base({ nudges: wk, lastSentAt: ago(24 * 5) })).shouldSend, false);
  assert.equal(decideNudge(base({ nudges: wk, lastSentAt: ago(24 * 7) })).shouldSend, true);
});
test("exam week boosts weekly to daily", () => {
  const wk = { ...base().nudges, frequency: "weekly" as const };
  const lastSentAt = new Date(base().now.getTime() - 23 * 3600_000).toISOString();
  const d = decideNudge(base({ nudges: wk, lastSentAt, exams: [{ subjectId: "s1", name: "Physics", examDate: "2026-11-02" }] }));
  assert.equal(d.shouldSend, true);
  assert.equal(d.kind, "exam_week");
  assert.match(d.body, /Physics exam in 5 days\. 3 concepts due/);
  // exam further than 7 days: no boost
  assert.equal(decideNudge(base({ nudges: wk, lastSentAt, exams: [{ subjectId: "s1", name: "Physics", examDate: "2026-11-20" }] })).shouldSend, false);
});
test("exam week nudges even when nothing is due", () => {
  const d = decideNudge(base({ dueCount: 0, exams: [{ subjectId: "s1", name: "Physics", examDate: "2026-10-31" }] }));
  assert.equal(d.shouldSend, true);
  assert.equal(d.kind, "exam_week");
});
test("night before exam offers exam-eve, once, and only in the evening", () => {
  const exams = [{ subjectId: "s1", name: "Physics", examDate: "2026-10-29" }];
  const evening = at("2026-10-28T13:30:00Z"); // 19:00 IST
  const lastSentAt = new Date(evening.getTime() - 3 * 3600_000).toISOString(); // daily already sent today
  const d = decideNudge(base({ now: evening, exams, lastSentAt }));
  assert.equal(d.kind, "exam_eve");
  assert.equal(d.target, "/exam-eve?subjectId=s1");
  assert.match(d.body, /Physics exam tomorrow/);
  assert.equal(decideNudge(base({ now: evening, exams, lastSentAt, examEveSentFor: ["s1"] })).shouldSend, false);
  // morning of the day before → regular exam-week nudge instead
  assert.equal(decideNudge(base({ exams })).kind, "exam_week");
  // evening but in quiet hours → nothing
  assert.equal(decideNudge(base({ now: at("2026-10-28T17:00:00Z"), exams })).shouldSend, false);
});

console.log(`\n${n} tests passed`);
