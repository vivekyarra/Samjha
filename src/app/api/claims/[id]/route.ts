import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { IngestError } from "@/lib/ingest";
import { assertSubject, ingestHandler, parseBody } from "@/lib/ingest/api";
import { claimSubjectId, deleteClaim, topicSubjectId, updateClaim } from "@/lib/ingest/review";

type Ctx = { params: Promise<{ id: string }> };

const PatchClaim = z.object({
  text: z.string().trim().min(3).max(400).optional(),
  page: z.number().int().min(1).nullable().optional(),
  topicId: z.string().min(1).optional(),
});

export const PATCH = ingestHandler(async (req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const { id } = await params;
  const subjectId = await claimSubjectId(id);
  await assertSubject(user, subjectId, "edit");
  const body = await parseBody(req, PatchClaim);
  if (body.topicId && await topicSubjectId(body.topicId) !== subjectId) throw new IngestError("Claims can only move within the same subject", 400);
  return Response.json({ claim: await updateClaim(id, body) });
});

export const DELETE = ingestHandler(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const { id } = await params;
  await assertSubject(user, await claimSubjectId(id), "edit");
  await deleteClaim(id);
  return Response.json({ ok: true });
});
