// Samjha auth. Local mode: a signed cookie holding the user id (no passwords). Demo users are flagged is_demo.
import "server-only";
import { cookies } from "next/headers";
import crypto from "node:crypto";
import { get, run, newId, now } from "./db";
import type { User } from "./types";

const COOKIE = "samjha_uid";
const SECRET = process.env.SAMJHA_SECRET || "samjha-dev-secret-change-me";

const sign = (v: string) => `${v}.${crypto.createHmac("sha256", SECRET).update(v).digest("hex").slice(0, 24)}`;
function unsign(s: string | undefined): string | null {
  if (!s) return null;
  const i = s.lastIndexOf(".");
  if (i < 0) return null;
  const v = s.slice(0, i);
  return sign(v) === s ? v : null;
}

/** Current user or null. Works in server components and route handlers. */
export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  const id = unsign(jar.get(COOKIE)?.value);
  if (!id) return null;
  return await get<User>("SELECT * FROM users WHERE id=?", id) ?? null;
}

/** Throws a 401 Response if not signed in. Use in route handlers: `const user = await requireUser();` */
export async function requireUser(): Promise<User> {
  const u = await currentUser();
  if (!u) throw new Response(JSON.stringify({ error: "Not signed in" }), { status: 401, headers: { "content-type": "application/json" } });
  return u;
}

export async function signIn(userId: string) {
  const jar = await cookies();
  jar.set(COOKIE, sign(userId), { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
}
export async function signOut() {
  (await cookies()).delete(COOKIE);
}

/** Find or create a user by email (local auth). */
export async function upsertUser(name: string, email: string | null, opts: { isDemo?: boolean } = {}): Promise<User> {
  if (email) {
    const existing = await get<User>("SELECT * FROM users WHERE email=?", email.toLowerCase());
    if (existing) return existing;
  }
  const id = newId("u_");
  await run("INSERT INTO users (id,name,email,is_demo,created_at) VALUES (?,?,?,?,?)", id, name, email?.toLowerCase() ?? null, opts.isDemo ? 1 : 0, now());
  return (await get<User>("SELECT * FROM users WHERE id=?", id))!;
}

/** Wrap a route handler so thrown Responses (e.g. from requireUser) and errors become JSON responses. */
export function handler<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof Response) return e;
      console.error("[samjha api]", e);
      return Response.json({ error: e instanceof Error ? e.message : "Something went wrong" }, { status: 500 });
    }
  };
}

/** Does this user have access to the subject (owner or member)? */
export async function canAccessSubject(userId: string, subjectId: string): Promise<boolean> {
  return !!await get("SELECT 1 FROM subject_members WHERE subject_id=? AND user_id=?", subjectId, userId);
}
