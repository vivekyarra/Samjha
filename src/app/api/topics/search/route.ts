import { requireUser } from "@/lib/auth";
import { searchTopics } from "@/lib/ingest";
import { ingestHandler } from "@/lib/ingest/api";

export const GET = ingestHandler(async (req: Request) => {
  const user = await requireUser();
  const q = (new URL(req.url).searchParams.get("q") ?? "").slice(0, 200);
  const results = await searchTopics(user.id, q, 8);
  const topic = results[0] && results[0].score >= 0.55 ? results[0] : null;
  return Response.json({ topic, results });
});
