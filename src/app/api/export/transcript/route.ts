import { handler, requireUser } from "@/lib/auth";
import { logEvent } from "@/lib/db";
import { attachment } from "@/lib/exports/anki";
import { buildTranscript, getAttemptOwner } from "@/lib/exports/transcript";

export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  const attemptId = new URL(req.url).searchParams.get("attemptId");
  if (!attemptId) return Response.json({ error: "attemptId is required" }, { status: 400 });
  const owner = await getAttemptOwner(attemptId);
  if (!owner) return Response.json({ error: "Session not found" }, { status: 404 });
  if (owner !== user.id) return Response.json({ error: "You don't have access to this session" }, { status: 403 });
  const { fileName, markdown } = await buildTranscript(attemptId);
  await logEvent(user.id, "export_transcript", { attemptId });
  return new Response(markdown, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": attachment(fileName),
      "cache-control": "no-store",
    },
  });
});
