import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { createSubject, listSubjects } from "@/lib/ingest";
import { ingestHandler, parseBody } from "@/lib/ingest/api";

const CreateSubject = z.object({
  name: z.string().trim().min(1, "Give the subject a name").max(120),
  examDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}/, "Use a date like 2026-12-01").nullish().or(z.literal("")),
});

export const GET = ingestHandler(async () => {
  const user = await requireUser();
  return Response.json({ subjects: await listSubjects(user.id) });
});

export const POST = ingestHandler(async (req: Request) => {
  const user = await requireUser();
  const body = await parseBody(req, CreateSubject);
  const subject = await createSubject(user.id, body.name, body.examDate || null);
  return Response.json({ subject }, { status: 201 });
});
