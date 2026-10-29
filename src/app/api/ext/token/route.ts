// Returns the signed-in user's extension token. Cookie-session only (a token cannot mint itself).
import { handler, requireUser } from "@/lib/auth";
import { logEvent } from "@/lib/db";
import { extToken } from "../_shared";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const user = await requireUser();
  await logEvent(user.id, "ext_token_viewed");
  return Response.json({ token: extToken(user.id), name: user.name }, { headers: { "cache-control": "no-store" } });
});
