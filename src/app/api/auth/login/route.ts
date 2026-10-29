// POST /api/auth/login {name, email} → local sign-in (no passwords). New users go to onboarding.
import { z } from "zod";
import { run, logEvent } from "@/lib/db";
import { handler, signIn, upsertUser } from "@/lib/auth";
import { rateLimit } from "@/lib/ratelimit";

const Body = z.object({
  name: z.string().trim().min(1, "Tell us your name").max(80),
  email: z.string().trim().toLowerCase().email("That email doesn't look right").max(200),
});

export const POST = handler(async (req: Request) => {
  const ip = (req.headers.get("x-forwarded-for")?.split(",")[0] || "local").trim();
  if (!await rateLimit(`login:${ip}`, 30, 600)) return Response.json({ error: "Too many sign-in attempts. Try again in a few minutes." }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid details" }, { status: 400 });
  const user = await upsertUser(parsed.data.name, parsed.data.email);
  if (user.is_demo) await run("UPDATE users SET is_demo=0 WHERE id=?", user.id);
  await signIn(user.id);
  await logEvent(user.id, "login", {});
  return Response.json({ ok: true, redirect: user.onboarded ? "/home" : "/onboarding" });
});
