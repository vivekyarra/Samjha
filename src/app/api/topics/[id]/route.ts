import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { getTopicWithClaims } from "@/lib/ingest";
import { assertSubject, ingestHandler, parseBody } from "@/lib/ingest/api";
import { deleteTopic, topicSubjectId, updateTopic } from "@/lib/ingest/review";

type Ctx = { params: Promise<{ id: string }> };

const PatchTopic = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  inExam: z.boolean().optional(),
  in_exam: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
});

export const GET = ingestHandler(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const { id } = await params;
  await assertSubject(user, await topicSubjectId(id));
  return Response.json({ topic: await getTopicWithClaims(id) });
});

export const PATCH = ingestHandler(async (req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const { id } = await params;
  const body = await parseBody(req, PatchTopic);
  // any member may flag "will be in the exam"; structural edits are for the owner
  const onlyExamFlag = body.name === undefined && body.position === undefined;
  await assertSubject(user, await topicSubjectId(id), onlyExamFlag ? "read" : "edit");
  await updateTopic(id, { name: body.name, inExam: body.inExam ?? body.in_exam, position: body.position });
  return Response.json({ topic: await getTopicWithClaims(id) });
});

export const DELETE = ingestHandler(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const { id } = await params;
  await assertSubject(user, await topicSubjectId(id), "edit");
  await deleteTopic(id);
  return Response.json({ ok: true });
});
