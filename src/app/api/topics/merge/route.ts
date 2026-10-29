import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { assertSubject, ingestHandler, parseBody } from "@/lib/ingest/api";
import { mergeTopics, topicSubjectId } from "@/lib/ingest/review";

const MergeBody = z.object({
  ids: z.array(z.string().min(1)).min(2, "Pick at least two topics").max(20),
  name: z.string().trim().max(120).optional(),
});

export const POST = ingestHandler(async (req: Request) => {
  const user = await requireUser();
  const body = await parseBody(req, MergeBody);
  for (const id of body.ids) await assertSubject(user, await topicSubjectId(id), "edit");
  return Response.json({ topic: await mergeTopics(body.ids, body.name) });
});
