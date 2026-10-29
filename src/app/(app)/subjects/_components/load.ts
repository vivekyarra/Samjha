import "server-only";
import { getSubjectGraph, listSources } from "@/lib/ingest";
import { canEditSubject } from "@/lib/ingest/review";
import { getClaimMastery, topicColour } from "@/lib/mastery";
import type { ReviewSource, ReviewTopic } from "./types";

/** Subject graph + this user's mastery, shaped for the review screen. */
export async function loadReview(userId: string, subjectId: string) {
  const graph = await getSubjectGraph(subjectId);
  const ids = graph.topics.flatMap((t) => t.claims.map((c) => c.id));
  const mastery = await getClaimMastery(userId, ids);
  const topics: ReviewTopic[] = graph.topics.map((t) => {
    const claims = t.claims.map((c) => ({ id: c.id, text: c.text, source_id: c.source_id, page: c.page, position: c.position, mastery: mastery[c.id] ?? "red" }));
    const green = claims.length ? claims.filter((c) => c.mastery === "green").length / claims.length : 0;
    return { id: t.id, name: t.name, position: t.position, in_exam: t.in_exam, claims, mastery: claims.length ? topicColour(green) : "red" };
  });
  const sources: ReviewSource[] = (await listSources(subjectId)).map((s) => ({ id: s.id, file_name: s.file_name, pages: s.pages, mime: s.mime }));
  return {
    subject: { id: graph.subject.id, name: graph.subject.name, exam_date: graph.subject.exam_date },
    topics,
    prerequisites: graph.prerequisites,
    sources,
    canEdit: await canEditSubject(userId, subjectId),
  };
}
