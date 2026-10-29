// Examiner persona phrasing. Question bank text is neutral; personas wrap it.
import type { Persona, Verdict } from "./types";

const pick = <T,>(arr: T[], variant: number): T => arr[Math.abs(variant) % arr.length];

export function perQuestionSec(p: Persona): number {
  return p === "fast" ? 45 : p === "strict" ? 90 : 120;
}

export function maxFollowUps(p: Persona): number {
  return p === "fast" ? 1 : 2;
}

export function phraseQuestion(p: Persona, text: string, n: number, isFollowUp: boolean): string {
  if (isFollowUp) return text;
  if (n === 1) {
    if (p === "friendly") return `Alright, let's start easy. ${text}`;
    if (p === "strict") return `We will begin. ${text}`;
    return `Let's go. ${text}`;
  }
  const lead =
    p === "friendly" ? pick(["Nice. Next one: ", "Okay, let's try this: ", "Cool. ", "Good, moving on. "], n)
    : p === "strict" ? pick(["Next question. ", "Now. ", "Moving on. ", ""], n)
    : pick(["Next: ", "Quick one: ", "Go: ", ""], n);
  return lead + text;
}

export function feedbackLine(p: Persona, verdict: Verdict, strong: string | undefined, missing: string | undefined, variant: number): string {
  const s = strong ? ` ${strong}` : "";
  const m = missing ? ` ${missing}` : "";
  if (verdict === "skipped") {
    return p === "friendly" ? "No worries, we'll come back to that kind of question." : p === "strict" ? "No answer. Noted." : "Skipped.";
  }
  if (p === "friendly") {
    if (verdict === "strong") return pick(["Nice, that's solid.", "Yes! That's it.", "Great answer."], variant) + (strong ? ` You nailed:${s}.` : "");
    if (verdict === "partial") return `Good start.${missing ? ` You didn't mention${m}.` : ""}`;
    return `Not quite.${missing ? ` The key bit is${m}.` : ""}`;
  }
  if (p === "strict") {
    if (verdict === "strong") return pick(["Correct.", "Acceptable.", "That is right."], variant);
    if (verdict === "partial") return `Incomplete.${missing ? ` You omitted${m}.` : ""}`;
    return `Insufficient.${missing ? ` You did not address${m}.` : ""}`;
  }
  if (verdict === "strong") return pick(["Good.", "Right.", "Yep."], variant);
  if (verdict === "partial") return `Partly.${missing ? ` Missed${m}.` : ""}`;
  return `Missed it.${missing ? ` Key:${m}.` : ""}`;
}

/** Follow-up probes on weak answers (spec F10): "Why?", "What happens if...?", "Where would this fail?". */
export function probe(p: Persona, topic: string, kw: string, attempt: number, variant: number): string {
  const k = kw || topic;
  const generic = [
    `Why? How does ${k} come into ${topic}?`,
    `What happens in ${topic} if ${k} goes wrong or is missing?`,
    `Where would ${topic} fail? Think about ${k}.`,
    `Give me a concrete example of ${k} in ${topic}.`,
  ];
  const q = pick(generic, variant + attempt);
  if (p === "friendly") return `Let me nudge you a bit. ${q}`;
  if (p === "strict") return `Be precise. ${q}`;
  return q;
}

export function personaSwitchLine(p: Persona): string {
  if (p === "strict") return "Very well. I will be your strict professor from now on.";
  if (p === "fast") return "Switching to fast-paced. Short answers, quick pace.";
  return "Sure, I'll go easy. Friendly senior mode.";
}

export function closingLine(p: Persona, overall: number): string {
  if (p === "friendly") return overall >= 70 ? "That was a great viva. Here's your scorecard." : "Good effort! Here's what to work on.";
  if (p === "strict") return `The viva is over. Your score is ${overall} out of 100.`;
  return `Time. You scored ${overall}. Scorecard's up.`;
}
