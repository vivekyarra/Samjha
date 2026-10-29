import { handler, requireUser } from "@/lib/auth";
import { dueToday } from "@/lib/mastery";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const user = await requireUser();
  const due = await dueToday(user.id);
  return Response.json({
    ...due,
    topics: due.topics.map((t) => ({ ...t, count: t.claimIds.length, href: `/session/${t.topicId}?kind=review&claims=${t.claimIds.join(",")}` })),
  });
});
