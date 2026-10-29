"use client";
import { ErrorState } from "@/components/ui";

export default function OnboardingError({ reset }: { error: Error; reset: () => void }) {
  return <ErrorState title="Onboarding hit a snag" body="Nothing is lost. Try again, or skip straight to your heatmap." retry={reset} />;
}
