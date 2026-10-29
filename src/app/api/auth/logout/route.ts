// POST /api/auth/logout → clears the session cookie.
import { handler, signOut } from "@/lib/auth";

export const POST = handler(async () => {
  await signOut();
  return Response.json({ ok: true, redirect: "/" });
});
