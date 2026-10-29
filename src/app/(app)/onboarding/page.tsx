import { currentUser } from "@/lib/auth";
import { Onboarding } from "./Onboarding";

export const dynamic = "force-dynamic";
export const metadata = { title: "Welcome · Samjha" };

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const user = await currentUser();
  const { step } = await searchParams;
  const n = Math.min(3, Math.max(0, Number(step ?? 1) - 1 || 0));
  return <Onboarding name={user?.name ?? "there"} initialLanguage={user?.language ?? "English"} initialStep={n} />;
}
