import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { allHeatmaps, dueToday, nextToStudy, streakInfo } from "@/lib/mastery";
import { HomeClient } from "./HomeClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Heatmap · Samjha" };

export default async function HomePage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const heatmaps = await allHeatmaps(user.id);
  const due = await dueToday(user.id);
  const next = await nextToStudy(user.id);
  const streak = await streakInfo(user.id);
  return <HomeClient name={user.name} heatmaps={heatmaps} due={due} next={next} streak={streak} />;
}
