// Shared route-handler helpers for A1 APIs: auth + access checks, zod body parsing, friendly errors.
import "server-only";
import { z, ZodError, type ZodType } from "zod";
import { handler, canAccessSubject } from "@/lib/auth";
import type { User } from "@/lib/types";
import { IngestError } from "./index";
import { canEditSubject } from "./review";

export function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

/** handler() plus IngestError → its status, ZodError → 400. */
export function ingestHandler<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return handler(async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof IngestError) return jsonError(e.message, e.status);
      if (e instanceof ZodError) return jsonError(e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), 400);
      throw e;
    }
  });
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new IngestError("Request body must be JSON", 400);
  }
  return schema.parse(raw);
}

/** Throws 404/403 unless the user can read (or edit) the subject. */
export async function assertSubject(user: User, subjectId: string | null, mode: "read" | "edit" = "read") {
  if (!subjectId) throw new IngestError("Not found", 404);
  if (!await canAccessSubject(user.id, subjectId)) throw new IngestError("You don't have access to this subject", 403);
  if (mode === "edit" && !await canEditSubject(user.id, subjectId)) throw new IngestError("Only the subject owner can change its topics", 403);
}

export const idSchema = z.string().min(1).max(64);
