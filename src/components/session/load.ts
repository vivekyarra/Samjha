import "server-only";
import { all, get } from "@/lib/db";
import { canAccessSubject } from "@/lib/auth";
import type { Claim, Mastery, Topic } from "@/lib/types";

export interface LoadedClaim extends Claim {
  file_name: string | null;
  mastery: Mastery;
  due: boolean;
}

export interface LoadedTopic extends Topic {
  subject_name: string;
}

/** Topic the user can access, or null. */
export async function loadTopic(userId: string, topicId: string): Promise<LoadedTopic | null> {
  const t = await get<LoadedTopic>(
    "SELECT t.*, s.name AS subject_name FROM topics t JOIN subjects s ON s.id = t.subject_id WHERE t.id = ?",
    topicId,
  );
  if (!t || !await canAccessSubject(userId, t.subject_id)) return null;
  return t;
}

/** Claims with this user's mastery (due green claims show amber, spec F5/F6). */
export async function loadClaims(userId: string, topicId: string): Promise<LoadedClaim[]> {
  const rows = await all<Claim & { file_name: string | null; mastery: string | null; due_at: string | null }>(
    `SELECT c.*, src.file_name, cc.mastery, cc.due_at
       FROM claims c
       LEFT JOIN sources src ON src.id = c.source_id
       LEFT JOIN claim_cards cc ON cc.claim_id = c.id AND cc.user_id = ?
      WHERE c.topic_id = ?
      ORDER BY c.position, c.rowid`,
    userId,
    topicId,
  );
  const nowIso = new Date().toISOString();
  return rows.map(({ due_at, mastery, ...c }) => {
    const due = !!due_at && due_at <= nowIso;
    let m: Mastery = mastery === "green" || mastery === "amber" ? mastery : "red";
    if (m === "green" && due) m = "amber";
    return { ...c, mastery: m, due };
  });
}

export function topicMastery(claims: { mastery: Mastery }[]): Mastery {
  if (!claims.length) return "red";
  const share = claims.filter((c) => c.mastery === "green").length / claims.length;
  return share >= 0.9 ? "green" : share >= 0.4 ? "amber" : "red";
}
