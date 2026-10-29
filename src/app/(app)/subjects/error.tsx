"use client";
import Link from "next/link";
import { ErrorState } from "@/components/ui/ErrorState";

export default function SubjectsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-xl">
      <ErrorState
        title="Couldn't open this subject"
        body="Your notes are safe. Give it a moment and try again."
        retry={reset}
        action={
          <Link href="/home" className="btn-ghost">
            Back to heatmap
          </Link>
        }
      />
    </div>
  );
}
