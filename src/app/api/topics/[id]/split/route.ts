import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { assertSubject, ingestHandler, parseBody } from "@/lib/ingest/api";
import { splitTopic, topicSubjectId } from "@/lib/ingest/review";

type Ctx = { params: Promise<{ id: string }> };

const SplitBody = z.object({
  claimIds: z.array(z.string().min(1)).min(1, "Pick the claims to move"),
  name: z.string().trim().max(120).default(""),
});

export const POST = ingestHandler(async (req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const { id } = await params;
  await assertSubject(user, await topicSubjectId(id), "edit");
  const body = await parseBody(req, SplitBody);
  return Response.json(await splitTopic(id, body.claimIds, body.name), { status: 201 });
});
