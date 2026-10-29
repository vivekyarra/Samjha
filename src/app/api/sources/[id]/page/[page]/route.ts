import { requireUser } from "@/lib/auth";
import { getSourcePage, IngestError } from "@/lib/ingest";
import { assertSubject, ingestHandler } from "@/lib/ingest/api";
import { sourceSubjectId } from "@/lib/ingest/review";

type Ctx = { params: Promise<{ id: string; page: string }> };

export const GET = ingestHandler(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const { id, page } = await params;
  await assertSubject(user, await sourceSubjectId(id));
  const n = parseInt(page, 10);
  if (!Number.isFinite(n) || n < 1) throw new IngestError("Page must be a positive number", 400);
  const res = await getSourcePage(id, n);
  if (!res) throw new IngestError("Source not found", 404);
  return Response.json({ sourceId: id, fileName: res.source.file_name, page: res.page, pages: res.pages, text: res.text, url: res.source.url });
});
