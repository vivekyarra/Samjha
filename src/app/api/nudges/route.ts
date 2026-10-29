import { handler, requireUser } from "@/lib/auth";
import { computeNudge, listNudges } from "@/lib/nudges";

/** My nudge history + what the scheduler would do right now. */
export const GET = handler(async () => {
  const user = await requireUser();
  const next = await computeNudge(user.id, new Date()).catch(() => null);
  return Response.json({
    nudges: await listNudges(user.id),
    next: next && { shouldSend: next.shouldSend, reason: next.reason, body: next.body, dueCount: next.dueCount, channels: next.channels },
    live: { email: !!process.env.RESEND_API_KEY, whatsapp: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM) },
  });
});
