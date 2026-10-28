// Shared types for Samjha. Every module imports from here; do not redefine these elsewhere.

export type ClaimStatus = "covered" | "missing" | "wrong";
export type Mastery = "red" | "amber" | "green";
export type AttemptKind = "explain" | "explain_back" | "review" | "viva" | "exam_eve";

export interface User { id: string; name: string; email: string | null; language: string; is_demo: number; onboarded: number; created_at: string }
export interface Subject { id: string; owner_id: string; name: string; exam_date: string | null; is_shared: number; join_code: string | null; created_at: string }
export interface Source { id: string; subject_id: string; file_name: string; storage_path: string | null; mime: string | null; pages: number; url: string | null }
export interface Chunk { id: string; source_id: string; page: number; text: string }
export interface Topic { id: string; subject_id: string; name: string; position: number; in_exam: number }
export interface Claim { id: string; topic_id: string; text: string; source_id: string | null; page: number | null; position: number }

/** One grading verdict for a claim (spec §8.3). */
export interface ClaimGrade { claim_id: string; status: ClaimStatus; evidence: string; correction: string; page: number | null }
export interface Misconception { quote: string; correction: string; page: number | null }
export interface GradeResult {
  claims: ClaimGrade[];
  misconceptions: Misconception[];
  strengths: string[];
  not_in_notes?: string[];
}

/** Preference keys (spec F4). Values are free strings, see PREF_DEFAULTS. */
export type PrefKey = "language" | "analogy" | "length" | "level" | "format" | "tone" | "scope";
export type Prefs = Record<PrefKey, string>;
export const PREF_DEFAULTS: Prefs = {
  language: "English",
  analogy: "",
  length: "short",
  level: "exam-level",
  format: "conversational",
  tone: "chill friend",
  scope: "only my gaps",
};

/** Voice intents (spec §5.2). */
export type Intent = "explanation" | "style" | "scope" | "interrupt" | "navigation" | "control" | "unclear";
export interface IntentResult {
  intent: Intent;
  /** Normalised arguments. For navigation: { target: "home"|"topic"|"heatmap"|..., topic?: string }.
   *  For control: { action: "stop"|"repeat"|"slower"|"faster"|"pause"|"resume"|"done"|"send"|"next" }.
   *  For style: { key: PrefKey, value: string, persist: "global"|"subject"|"once", remove?: boolean, reset?: boolean }.
   *  For scope: { scope: string }. For interrupt: { kind: "why"|"example"|"shorter"|"stuck"|"question", text }. */
  args: Record<string, string | boolean | undefined>;
  confidence: number;
  source: "rules" | "context" | "model";
}

export interface ApiError { error: string }
