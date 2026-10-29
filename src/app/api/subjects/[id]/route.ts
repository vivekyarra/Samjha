import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { getSubjectGraph, listSources } from "@/lib/ingest";
import { assertSubject, ingestHandler, parseBody } from "@/lib/ingest/api";
import { deleteSubject, updateSubject } from "@/lib/ingest/review";

type Ctx = { params: Promise<{ id: string }> };

const PatchSubject = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  examDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}/).nullish().or(z.literal("")),
});

export const GET = ingestHandler(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const { id } = await params;
  await assertSubject(user, id);
  return Response.json({ ...await getSubjectGraph(id), sources: await listSources(id) });
});

export const PATCH = ingestHandler(async (req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const { id } = await params;
  await assertSubject(user, id, "edit");
  const body = await parseBody(req, PatchSubject);
  return Response.json({ subject: await updateSubject(id, { name: body.name, examDate: body.examDate === undefined ? undefined : body.examDate || null }) });
});

export const DELETE = ingestHandler(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const { id } = await params;
  await assertSubject(user, id, "edit");
  await deleteSubject(id);
  return Response.json({ ok: true });
});
