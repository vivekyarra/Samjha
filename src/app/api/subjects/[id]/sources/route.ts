// Upload notes into a subject. multipart: file (+ mode=notes|syllabus, topicId) or JSON: {text, fileName, mode?, topicId?, url?}.
// Send `Accept: application/x-ndjson` (or ?stream=1) to receive progress lines, then {"type":"result",...}.
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { hasAI } from "@/lib/ai";
import { enforceAiLimit } from "@/lib/ratelimit";
import { ingestSource, IngestError, listSources, MAX_UPLOAD_BYTES, SYLLABUS_MIME, type IngestOptions, type IngestProgress } from "@/lib/ingest";
import { assertSubject, ingestHandler } from "@/lib/ingest/api";

export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string }> };

const JsonSource = z.object({
  text: z.string().min(1, "Paste some notes first").max(2_000_000),
  fileName: z.string().trim().max(200).optional(),
  mode: z.enum(["notes", "syllabus"]).optional(),
  topicId: z.string().min(1).optional(),
  url: z.string().url().max(2000).optional(),
});

export const GET = ingestHandler(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const { id } = await params;
  await assertSubject(user, id);
  return Response.json({ sources: await listSources(id) });
});

async function readInput(req: Request, subjectId: string): Promise<IngestOptions> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_UPLOAD_BYTES + 64 * 1024) throw new IngestError("That file is over 20 MB. Try splitting it into smaller files.", 413);
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new IngestError("We couldn't read that upload. Please try again.", 400);
    }
    const file = form.get("file");
    const mode = form.get("mode") === "syllabus" ? "syllabus" : "notes";
    const topicId = typeof form.get("topicId") === "string" && form.get("topicId") ? String(form.get("topicId")) : undefined;
    if (!(file instanceof File)) {
      const text = form.get("text");
      if (typeof text === "string" && text.trim()) return { subjectId, fileName: String(form.get("fileName") || "Pasted notes"), mime: mode === "syllabus" ? SYLLABUS_MIME : "text/plain", text, topicId };
      throw new IngestError("Choose a file to upload", 400);
    }
    if (file.size > MAX_UPLOAD_BYTES) throw new IngestError("That file is over 20 MB. Try splitting it into smaller files.", 413);
    if (file.size === 0) throw new IngestError("That file is empty", 400);
    const data = Buffer.from(await file.arrayBuffer());
    return { subjectId, fileName: file.name || "Upload", mime: mode === "syllabus" ? SYLLABUS_MIME : file.type || "", data, topicId };
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new IngestError("Send a file (multipart) or JSON with text", 400);
  }
  const body = JsonSource.parse(raw);
  return {
    subjectId,
    fileName: body.fileName || (body.mode === "syllabus" ? "Syllabus" : "Pasted notes"),
    mime: body.mode === "syllabus" ? SYLLABUS_MIME : "text/plain",
    text: body.text,
    topicId: body.topicId,
    url: body.url,
  };
}

export const POST = ingestHandler(async (req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const { id } = await params;
  await assertSubject(user, id, "edit");
  if (hasAI()) await enforceAiLimit(user, "ingest");
  const input = await readInput(req, id);
  const wantsStream = (req.headers.get("accept") ?? "").includes("application/x-ndjson") || new URL(req.url).searchParams.get("stream") === "1";

  if (!wantsStream) return Response.json(await ingestSource(input), { status: 201 });

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      try {
        const result = await ingestSource({ ...input, onProgress: (p: IngestProgress) => send({ type: "progress", ...p }) });
        send({ type: "result", ...result });
      } catch (e) {
        if (e instanceof IngestError) send({ type: "error", error: e.message, status: e.status });
        else {
          console.error("[samjha ingest]", e);
          send({ type: "error", error: "Something went wrong while reading your notes. Please try again.", status: 500 });
        }
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
});

