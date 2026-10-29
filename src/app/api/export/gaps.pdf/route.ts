import { canAccessSubject, handler, requireUser } from "@/lib/auth";
import { all, logEvent } from "@/lib/db";
import { attachment, safeFileName } from "@/lib/exports/anki";
import { gapsPdfForUser } from "@/lib/exports/gaps";

/** Gaps-only revision sheet. ?subjectId= for one subject, omit for all of mine (one page per subject). */
export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  const subjectId = new URL(req.url).searchParams.get("subjectId");
  let ids: string[];
  let name = "all-subjects";
  if (subjectId) {
    if (!await canAccessSubject(user.id, subjectId)) return Response.json({ error: "You don't have access to this subject" }, { status: 403 });
    ids = [subjectId];
    name = (await all<{ name: string }>("SELECT name FROM subjects WHERE id=?", subjectId))[0]?.name ?? "subject";
  } else {
    ids = (await all<{ id: string }>(
      "SELECT s.id FROM subjects s JOIN subject_members m ON m.subject_id=s.id WHERE m.user_id=? ORDER BY s.created_at",
      user.id,
    )).map((r) => r.id);
  }
  const pdf = await gapsPdfForUser(user.id, user.name, ids);
  await logEvent(user.id, "export_gaps_pdf", { subjectId, subjects: ids.length });
  return new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": attachment(`${safeFileName(name)}-gaps.pdf`),
      "cache-control": "no-store",
    },
  });
});
