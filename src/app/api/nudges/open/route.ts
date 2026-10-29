import { markOpened } from "@/lib/nudges";

/** Public: records that a nudge was opened, then redirects into the session. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const n = url.searchParams.get("n");
  const to = url.searchParams.get("to") || "/review";
  // Only same-site relative paths (no open redirect).
  const safe = to.startsWith("/") && !to.startsWith("//") && !to.startsWith("/\\") ? to : "/review";
  if (n) {
    try {
      await markOpened(n);
    } catch (e) {
      console.error("[nudges] open tracking failed", e);
    }
  }
  return Response.redirect(new URL(safe, url.origin), 302);
}
