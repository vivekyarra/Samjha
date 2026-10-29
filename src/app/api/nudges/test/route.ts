import { handler, requireUser } from "@/lib/auth";
import { rateLimit } from "@/lib/ratelimit";
import { sendNudge } from "@/lib/nudges";

/** Send myself a nudge right now (ignores cadence and quiet hours). */
export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  if (!await rateLimit(`nudge-test:${user.id}`, 5, 3600)) {
    return Response.json({ error: "That's enough test nudges for now. Try again later." }, { status: 429 });
  }
  const r = await sendNudge(user.id, { test: true, origin: new URL(req.url).origin });
  return Response.json({ body: r.decision.body, nudges: r.nudges });
});
