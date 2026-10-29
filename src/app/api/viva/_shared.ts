import "server-only";
import { sessionOwner, VivaError, RepoError } from "@/lib/viva";

/** 404 for missing or someone else's session (don't leak existence). */
export async function assertOwner(id: string, userId: string) {
  if (await sessionOwner(id) !== userId) throw new Response(JSON.stringify({ error: "Viva session not found" }), { status: 404, headers: { "content-type": "application/json" } });
}

/** Map expected domain errors to 400/422 with a user-facing message. */
export function domainError(e: unknown): Response {
  if (e instanceof RepoError) return Response.json({ error: e.message, pasteReadme: true }, { status: 422 });
  if (e instanceof VivaError) return Response.json({ error: e.message }, { status: 400 });
  throw e;
}

export async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const j = await req.json();
    return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
