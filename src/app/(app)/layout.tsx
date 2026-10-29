// Signed-in app shell: top nav + always-present Voice Box at the bottom (spec §7).
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { currentUser } from "@/lib/auth";
import { AppNav } from "@/components/AppNav";
import { VoiceProvider } from "@/components/voice/VoiceProvider";
import { ThemeApplier } from "@/components/settings/ThemeApplier";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) {
    const path = (await headers()).get("x-samjha-path");
    redirect(path && path.startsWith("/") && !path.startsWith("//") ? `/login?next=${encodeURIComponent(path)}` : "/login");
  }
  return (
    <VoiceProvider userLanguage={user.language}>
      <ThemeApplier />
      <AppNav user={{ name: user.name, isDemo: !!user.is_demo }} />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-48 pt-4">{children}</main>
    </VoiceProvider>
  );
}
