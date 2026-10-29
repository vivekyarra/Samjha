import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { dueToday, getUserSubjects, streakInfo } from "@/lib/mastery";
import { ReviewClient } from "./ReviewClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Today's review · Samjha" };

export default async function ReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const sp = await searchParams;
  const due = await dueToday(user.id);
  const hasSubjects = (await getUserSubjects(user.id)).length > 0;
  return <ReviewClient due={due} streak={(await streakInfo(user.id)).days} autoStart={sp.start === "1"} hasSubjects={hasSubjects} />;
}
