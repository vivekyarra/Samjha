"use client";
import Link from "next/link";

export default function SessionError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-xl">
      <div className="card space-y-3 text-center" role="alert">
        <h1 className="h2">This session hit a snag</h1>
        <p className="muted">Give it a moment and try again.</p>
        <div className="flex flex-wrap justify-center gap-2">
          <button type="button" className="btn-primary" onClick={reset}>
            Try again
          </button>
          <Link href="/home" className="btn-ghost">
            Back to heatmap
          </Link>
        </div>
      </div>
    </div>
  );
}
