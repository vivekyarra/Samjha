import type { AttemptKind, GradeResult, Mastery } from "@/lib/types";

export interface SessionClaim {
  id: string;
  text: string;
  source_id: string | null;
  page: number | null;
  mastery: Mastery;
}

export interface SessionTopic {
  id: string;
  name: string;
  subjectId: string;
}

export interface AttemptRecord {
  attemptId: string;
  kind: AttemptKind;
  explanation: string;
  result: GradeResult;
  mastery: Record<string, Mastery>;
}

export interface GradeResponse {
  attemptId: string;
  result: GradeResult;
  mastery: Record<string, Mastery>;
}

export type BuddyMode = "gaps" | "why" | "example" | "shorter" | "stuck" | "question" | "restyle" | "exam_eve" | "continue";

export type Phase = "explain" | "grading" | "result" | "buddy" | "explain_back" | "summary";
