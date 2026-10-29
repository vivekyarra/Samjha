// GET /demo: one click, no signup (spec F14). Fresh sandboxed demo user + sample ML subject, lands in a session.
import { redirect } from "next/navigation";
import { run, logEvent } from "@/lib/db";
import { upsertUser, signIn } from "@/lib/auth";
import { rateLimit } from "@/lib/ratelimit";
import { cleanupDemo, prepareSampleSubject } from "@/lib/demo/sample";

export const dynamic = "force-dynamic";

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd?.split(",")[0] || req.headers.get("x-real-ip") || "local").trim();
}

export async function GET(req: Request) {
  if (!await rateLimit(`demo:${clientIp(req)}`, 20, 3600)) redirect("/?demo=busy");

  let target = "/?demo=error";
  try {
    await cleanupDemo();
    const user = await upsertUser("Guest Student", null, { isDemo: true });
    await run("UPDATE users SET onboarded=1 WHERE id=?", user.id);
    const { topicIds } = await prepareSampleSubject(user.id);
    await signIn(user.id);
    await logEvent(user.id, "demo_started", {});
    target = `/session/${topicIds["Gradient Descent"]}?demo=1`;
  } catch (e) {
    console.error("[samjha demo]", e);
  }
  redirect(target);
}
