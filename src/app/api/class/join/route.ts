import { z } from "zod";
import { handler, requireUser } from "@/lib/auth";
import { rateLimit } from "@/lib/ratelimit";
import { joinByCode } from "@/lib/class";

const Body = z.object({ code: z.string().min(4).max(32) });

/** Join a shared subject by code. Throttled per user to stop code guessing. */
export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  if (!await rateLimit(`class-join:${user.id}`, 20, 3600)) return Response.json({ error: "Too many join attempts. Try again later." }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send a join code" }, { status: 400 });
  return Response.json(await joinByCode(user.id, parsed.data.code));
});
