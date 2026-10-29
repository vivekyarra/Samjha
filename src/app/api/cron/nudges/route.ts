import { runNudgeCron } from "@/lib/nudges";

export const dynamic = "force-dynamic";

/** Hourly (vercel.json). Guarded by `Authorization: Bearer ${CRON_SECRET}`; open when CRON_SECRET is unset (local dev). */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!secret && process.env.NODE_ENV === "production") {
    console.warn("[cron] CRON_SECRET is not set; /api/cron/nudges is unprotected");
  }
  try {
    const summary = await runNudgeCron(new Date(), new URL(req.url).origin);
    return Response.json({ ok: true, ...summary });
  } catch (e) {
    console.error("[cron] nudges failed", e);
    return Response.json({ error: "Nudge run failed" }, { status: 500 });
  }
}
