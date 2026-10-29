import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { SettingsClient } from "./SettingsClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings · Samjha" };

export default async function SettingsPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  return (
    <SettingsClient
      initial={await getSettings(user.id)}
      user={{ name: user.name, email: user.email, isDemo: !!user.is_demo }}
    />
  );
}
