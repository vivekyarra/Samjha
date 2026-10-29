import { canAccessSubject, handler, requireUser } from "@/lib/auth";
import { attachment, buildSubjectApkg } from "@/lib/exports/anki";
import { logEvent } from "@/lib/db";

export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  const subjectId = new URL(req.url).searchParams.get("subjectId");
  if (!subjectId) return Response.json({ error: "subjectId is required" }, { status: 400 });
  if (!await canAccessSubject(user.id, subjectId)) return Response.json({ error: "You don't have access to this subject" }, { status: 403 });
  const { fileName, data, cards } = await buildSubjectApkg(subjectId);
  await logEvent(user.id, "export_anki", { subjectId, cards });
  return new Response(new Uint8Array(data), {
    headers: {
      "content-type": "application/apkg",
      "content-disposition": attachment(fileName),
      "cache-control": "no-store",
      "x-samjha-cards": String(cards),
    },
  });
});
