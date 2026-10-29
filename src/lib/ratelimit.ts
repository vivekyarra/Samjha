import "server-only";
import { get, run } from "./db";

/** Fixed-window rate limit. Returns true if allowed. */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
  const t = Math.floor(Date.now() / 1000);
  const row = await get<{ count: number; window_start: number }>("SELECT count, window_start FROM rate_limits WHERE key=?", key);
  if (!row || t - row.window_start >= windowSec) {
    await run("INSERT INTO rate_limits (key,count,window_start) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count, window_start=excluded.window_start", key, 1, t);
    return true;
  }
  if (row.count >= limit) return false;
  await run("UPDATE rate_limits SET count=count+1 WHERE key=?", key);
  return true;
}

/** Throws 429 Response when limited. Demo users get tighter limits on AI routes. */
export async function enforceAiLimit(user: { id: string; is_demo: number }, bucket = "ai") {
  const limit = user.is_demo ? 40 : 300;
  if (!await rateLimit(`${bucket}:${user.id}`, limit, 3600)) {
    throw new Response(JSON.stringify({ error: "You're going a bit fast. Try again in a few minutes." }), { status: 429, headers: { "content-type": "application/json" } });
  }
}
