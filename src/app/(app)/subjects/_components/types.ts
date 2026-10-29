import type { Mastery } from "@/lib/types";

export interface ReviewClaim {
  id: string;
  text: string;
  source_id: string | null;
  page: number | null;
  position: number;
  mastery: Mastery;
}

export interface ReviewTopic {
  id: string;
  name: string;
  position: number;
  in_exam: number;
  mastery: Mastery;
  claims: ReviewClaim[];
}

export interface ReviewSubject {
  id: string;
  name: string;
  exam_date: string | null;
}

export interface ReviewSource {
  id: string;
  file_name: string;
  pages: number;
  mime: string | null;
}

export const citeHref = (c: { source_id: string | null; page: number | null; id?: string }) =>
  c.source_id ? `/sources/${encodeURIComponent(c.source_id)}?page=${c.page ?? 1}${c.id ? `&claim=${encodeURIComponent(c.id)}` : ""}` : null;

export async function api<T = Record<string, unknown>>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || "That didn't save. Try again.");
  return data as T;
}
