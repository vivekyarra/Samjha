// Shared helpers for the Chrome extension API (/api/ext/*): bearer-token auth + CORS for chrome-extension:// origins.
import "server-only";
import crypto from "node:crypto";
import { get } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import type { User } from "@/lib/types";

const SECRET = process.env.SAMJHA_SECRET || "samjha-dev-secret-change-me";

function mac(userId: string) {
  return crypto.createHmac("sha256", SECRET).update(`samjha-ext:${userId}`).digest("hex").slice(0, 32);
}

/** Per-user extension token: `<userId>.<hmac>`. Stable until SAMJHA_SECRET changes. */
export function extToken(userId: string) {
  return `${userId}.${mac(userId)}`;
}

async function userFromToken(token: string): Promise<User | null> {
  const i = token.lastIndexOf(".");
  if (i < 1) return null;
  const id = token.slice(0, i);
  const sig = token.slice(i + 1);
  const want = mac(id);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  return await get<User>("SELECT * FROM users WHERE id=?", id) ?? null;
}

/** Bearer token first (extension), then the normal session cookie. */
export async function extUser(req: Request): Promise<User | null> {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const u = await userFromToken(auth.slice(7).trim());
    if (u) return u;
  }
  return currentUser();
}

export async function requireExtUser(req: Request): Promise<User> {
  const u = await extUser(req);
  if (!u) throw new Response(JSON.stringify({ error: "Not signed in" }), { status: 401, headers: { "content-type": "application/json" } });
  return u;
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  if (!origin.startsWith("chrome-extension://")) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export function preflight(req: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

/** Wrap a handler: converts thrown Responses / errors to JSON and always attaches CORS headers. */
export function extHandler(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    let res: Response;
    try {
      res = await fn(req);
    } catch (e) {
      if (e instanceof Response) res = e;
      else {
        console.error("[samjha ext]", e);
        res = Response.json({ error: "Samjha had trouble with that. Please try again." }, { status: 500 });
      }
    }
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(corsHeaders(req))) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

export const badRequest = (error: string) => Response.json({ error }, { status: 400 });
