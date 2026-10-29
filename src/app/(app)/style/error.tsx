"use client";
import { ErrorState } from "@/components/ui/ErrorState";

export default function StyleError({ retry }: { error: Error; retry: () => void }) {
  return <ErrorState title="Couldn't load your style" body="Your preferences are safe. Try again in a moment." retry={retry} />;
}
