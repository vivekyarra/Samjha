// Run: npx tsx src/lib/mastery/rules.test.ts
import assert from "node:assert/strict";
import { Rating } from "ts-fsrs";
import {
  dayKey,
  effectiveMastery,
  masteryAfterGrade,
  rankTopics,
  ratingFor,
  reasonFor,
  scheduleCard,
  streakFromDates,
  topicColour,
  reviewMinutes,
} from "./rules";

let n = 0;
const test = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log("ok -", name);
};

test("rating mapping (F6)", () => {
  assert.equal(ratingFor("wrong", false), Rating.Again);
  assert.equal(ratingFor("missing", true), Rating.Hard);
  assert.equal(ratingFor("covered", true), Rating.Good);
  assert.equal(ratingFor("covered", false), Rating.Easy);
});

test("mastery after grade (F5)", () => {
  assert.equal(masteryAfterGrade("wrong", "explain", false), "red");
  assert.equal(masteryAfterGrade("missing", "explain_back", true), "red");
  assert.equal(masteryAfterGrade("covered", "explain", true), "amber");
  assert.equal(masteryAfterGrade("covered", "explain_back", true), "green");
  assert.equal(masteryAfterGrade("covered", "explain", false), "green");
  assert.equal(masteryAfterGrade("covered", "review", false), "green");
});

test("due claims turn amber on read", () => {
  const now = new Date("2026-10-28T10:00:00Z");
  assert.equal(effectiveMastery("green", "2026-10-28T09:00:00Z", now), "amber");
  assert.equal(effectiveMastery("green", "2026-11-05T09:00:00Z", now), "green");
  assert.equal(effectiveMastery("red", "2026-10-01T09:00:00Z", now), "red");
  assert.equal(effectiveMastery(null, null, now), "red");
});

test("topic colour thresholds", () => {
  assert.equal(topicColour(0), "red");
  assert.equal(topicColour(0.39), "red");
  assert.equal(topicColour(0.4), "amber");
  assert.equal(topicColour(0.89), "amber");
  assert.equal(topicColour(0.9), "green");
  assert.equal(topicColour(1), "green");
  assert.equal(topicColour(75), "amber");
});

test("FSRS schedules: wrong due soon, easy due later, state round-trips", () => {
  const now = new Date("2026-10-28T10:00:00Z");
  const wrong = scheduleCard(null, "wrong", false, now);
  const easy = scheduleCard(null, "covered", false, now);
  assert.ok(new Date(wrong.dueAt) < new Date(easy.dueAt));
  assert.ok(new Date(easy.dueAt).getTime() - now.getTime() > 24 * 3600 * 1000, "easy should be ≥1 day out");
  const later = new Date(easy.dueAt);
  const again = scheduleCard(easy.stateJson, "covered", false, later);
  assert.ok(new Date(again.dueAt) > later, "second review pushes further out");
  assert.equal(again.card.reps, 2);
});

test("priority: red first, then dependants, exam flag, then amber", () => {
  const ranked = rankTopics([
    { id: "a", name: "Overfitting", mastery: "amber", greenPct: 50, dependants: 5, inExam: true },
    { id: "b", name: "Loss functions", mastery: "red", greenPct: 10, dependants: 0, inExam: true },
    { id: "c", name: "Chain rule", mastery: "red", greenPct: 20, dependants: 2, inExam: false },
    { id: "d", name: "Linear models", mastery: "green", greenPct: 100, dependants: 9, inExam: true },
    { id: "e", name: "Backprop", mastery: "red", greenPct: 0, dependants: 0, inExam: false },
  ]);
  assert.deepEqual(ranked.map((t) => t.id), ["c", "b", "e", "a"]);
  assert.equal(reasonFor(ranked[0]), "Chain rule is red and 2 topics depend on it.");
  assert.match(reasonFor(ranked[1]), /flagged it for the exam/);
});

test("streak counts consecutive local days ending today or yesterday", () => {
  const tz = "Asia/Kolkata";
  const now = new Date("2026-10-28T12:00:00+05:30");
  const d = (s: string) => new Date(s);
  assert.deepEqual(streakFromDates([], now, tz), { days: 0, today: false, longest: 0 });
  const s1 = streakFromDates([d("2026-10-28T09:00:00+05:30"), d("2026-10-27T23:30:00+05:30"), d("2026-10-26T08:00:00+05:30"), d("2026-10-24T08:00:00+05:30")], now, tz);
  assert.equal(s1.days, 3);
  assert.equal(s1.today, true);
  const s2 = streakFromDates([d("2026-10-27T10:00:00+05:30"), d("2026-10-26T10:00:00+05:30")], now, tz);
  assert.equal(s2.days, 2);
  assert.equal(s2.today, false);
  assert.equal(streakFromDates([d("2026-10-25T10:00:00+05:30")], now, tz).days, 0);
  // 00:30 IST on the 28th is still the 27th in UTC: local day must win
  assert.equal(dayKey(d("2026-10-28T00:30:00+05:30"), tz), "2026-10-28");
});

test("review minutes", () => {
  assert.equal(reviewMinutes(0), 0);
  assert.equal(reviewMinutes(3), 6);
});

console.log(`\n${n} tests passed`);
