import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { IngestError } from "@/lib/ingest";
import { assertSubject, ingestHandler, parseBody } from "@/lib/ingest/api";
import { createClaim, sourceSubjectId, topicSubjectId } from "@/lib/ingest/review";

const CreateClaim = z.object({
  topicId: z.string().min(1),
  text: z.string().trim().min(3, "Claim is too short").max(400),
  sourceId: z.string().min(1).nullish(),
  page: z.number().int().min(1).nullish(),
  position: z.number().int().min(0).optional(),
});

export const POST = ingestHandler(async (req: Request) => {
  const user = await requireUser();
  const body = await parseBody(req, CreateClaim);
  const subjectId = await topicSubjectId(body.topicId);
  await assertSubject(user, subjectId, "edit");
  if (body.sourceId && await sourceSubjectId(body.sourceId) !== subjectId) throw new IngestError("That source belongs to another subject", 400);
  const claim = await createClaim({ topicId: body.topicId, text: body.text, sourceId: body.sourceId, page: body.page, position: body.position });
  return Response.json({ claim }, { status: 201 });
});
