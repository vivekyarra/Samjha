// Viva + Placement shared types (safe to import from client components).

export type Persona = "friendly" | "strict" | "fast";
export type VivaMode = "viva" | "placement";
export type Level = 1 | 2 | 3;
export type Verdict = "strong" | "partial" | "weak" | "skipped";

export const PERSONAS: { id: Persona; label: string; blurb: string }[] = [
  { id: "friendly", label: "Friendly senior", blurb: "Warm, gives hints, two follow-ups max." },
  { id: "strict", label: "Strict professor", blurb: "Formal, precise, no hand-holding." },
  { id: "fast", label: "Fast-paced interviewer", blurb: "45 seconds per question, rapid fire." },
];
export const DURATIONS = [5, 10, 15] as const;
export type Duration = (typeof DURATIONS)[number];

export interface Citation { label: string; href: string }

export interface VivaQuestion {
  id: string;
  text: string;
  level: Level;
  kind: string;
  topicId?: string;
  topicName?: string;
  claimIds: string[];
  /** Placement: repo terms a good answer would mention. */
  expected?: string[];
  parentId?: string;
}

export interface VivaAnswer {
  questionId: string;
  text: string;
  score: number;
  verdict: Verdict;
  strong: string[];
  missing: string[];
  citations: Citation[];
  feedback: string;
  at: number;
}

export interface RepoSummary {
  label: string;
  url: string | null;
  name: string;
  description: string;
  languages: string[];
  topDirs: string[];
  notableFiles: string[];
  deps: string[];
  readmeHeadings: string[];
  hasTests: boolean;
  terms: string[];
  readmeExcerpt: string;
  pathsSample: string[];
}

export interface VivaState {
  startedAt: number;
  level: Level;
  bank: VivaQuestion[];
  asked: VivaQuestion[];
  answers: VivaAnswer[];
  current: VivaQuestion | null;
  /** Follow-ups asked for the current root question. */
  followUps: number;
  lastFeedback: string;
  repo?: RepoSummary;
  subjectName?: string;
}

export interface ScorecardItem {
  question: string;
  answer: string;
  verdict: Verdict;
  strong: string[];
  missing: string[];
  citations: Citation[];
  isFollowUp: boolean;
}

export interface PrepareItem { question: string; why: string; outline: string }

export interface Scorecard {
  mode: VivaMode;
  persona: Persona;
  overall: number;
  summary: string;
  items: ScorecardItem[];
  prepare: PrepareItem[];
  durationSec: number;
  title: string;
}

export interface CurrentQuestionView { id: string; text: string; level: Level; isFollowUp: boolean; number: number }

export interface VivaView {
  id: string;
  mode: VivaMode;
  persona: Persona;
  durationMin: number;
  title: string;
  startedAt: number;
  endsAt: number;
  perQuestionSec: number;
  level: Level;
  current: CurrentQuestionView | null;
  lastFeedback: string;
  answered: number;
  done: boolean;
  scorecard: Scorecard | null;
}

export interface AnswerResult {
  feedbackLine: string;
  nextQuestion: CurrentQuestionView | null;
  done: boolean;
  view: VivaView;
}

export interface VivaHistoryItem {
  id: string;
  mode: VivaMode;
  persona: Persona;
  title: string;
  createdAt: string;
  endedAt: string | null;
  overall: number | null;
}

export function personaLabel(p: Persona): string {
  return PERSONAS.find((x) => x.id === p)?.label ?? p;
}

/** Parse a spoken persona name ("strict professor", "be friendly", "fast interviewer"). */
export function parsePersona(text: string): Persona | null {
  const t = text.toLowerCase();
  if (/\b(strict|professor|prof)\b/.test(t)) return "strict";
  if (/\b(fast|quick|rapid|interviewer)\b/.test(t)) return "fast";
  if (/\b(friendly|senior|nice|chill|kind)\b/.test(t)) return "friendly";
  return null;
}
