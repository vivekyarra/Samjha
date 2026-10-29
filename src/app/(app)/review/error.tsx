"use client";
import { useEffect } from "react";
import Link from "next/link";
import { ErrorState } from "@/components/ui";

export default function ReviewError({ error, retry, reset }: { error: unknown; retry?: () => void; reset?: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="mx-auto max-w-xl py-6">
      <ErrorState
        title="Couldn't load today's review"
        body="Your schedule is safe. Try again in a moment."
        retry={retry ?? reset}
        action={<Link href="/home" className="btn-ghost">Back to heatmap</Link>}
      />
    </div>
  );
}
