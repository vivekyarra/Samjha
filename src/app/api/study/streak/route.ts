import { handler, requireUser } from "@/lib/auth";
import { streakInfo } from "@/lib/mastery";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const user = await requireUser();
  return Response.json(await streakInfo(user.id));
});
