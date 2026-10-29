"use client";
import { useEffect } from "react";
import Link from "next/link";
import { ErrorState } from "@/components/ui";

export default function HomeError({ error, retry, reset }: { error: unknown; retry?: () => void; reset?: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="mx-auto max-w-xl py-6">
      <ErrorState
        title="Couldn't load your heatmap"
        body="Your progress is saved. Try again, or jump straight into review."
        retry={retry ?? reset}
        action={<Link href="/review" className="btn-ghost">Go to review</Link>}
      />
    </div>
  );
}
