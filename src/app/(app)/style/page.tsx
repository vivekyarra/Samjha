import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { all } from "@/lib/db";
import { listPrefs } from "@/lib/prefs";
import { PREF_DEFAULTS } from "@/lib/types";
import { StyleClient } from "./StyleClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "My style · Samjha" };

export default async function StylePage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const subjects = await all<{ id: string; name: string }>(
    "SELECT s.id, s.name FROM subjects s JOIN subject_members m ON m.subject_id=s.id WHERE m.user_id=? ORDER BY s.name",
    user.id,
  );
  return <StyleClient initialPrefs={await listPrefs(user.id)} subjects={subjects} defaults={PREF_DEFAULTS} />;
}
