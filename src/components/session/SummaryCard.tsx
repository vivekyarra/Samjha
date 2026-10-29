"use client";
import Link from "next/link";
import { MasteryBadge } from "@/components/ui/MasteryBadge";
import type { Mastery } from "@/lib/types";
import { formatDuration } from "./text";

export interface NextTopic { topicId: string; name: string; reason?: string }

export function SummaryCard({
  topicName,
  fixed,
  coveredNow,
  total,
  durationMs,
  masteryCounts,
  streak,
  next,
  returnTo,
  gapsLeft,
  onBuddyAgain,
  onStartAgain,
}: {
  topicName: string;
  fixed: number;
  coveredNow: number;
  total: number;
  durationMs: number;
  masteryCounts: Record<Mastery, number>;
  streak: number | null;
  next: NextTopic | null;
  returnTo: { id: string; name: string } | null;
  gapsLeft: number;
  onBuddyAgain: () => void;
  onStartAgain: () => void;
}) {
  return (
    <section className="space-y-4" aria-label="Session summary">
      <div className="card text-center">
        <p className="text-sm uppercase tracking-wide text-muted">Session done</p>
        <h1 className="h1 mt-1 break-words">{topicName}</h1>
        <dl className="mt-4 grid grid-cols-3 gap-2">
          <div className="rounded-xl bg-green-soft p-3">
            <dt className="text-xs text-muted">Ideas fixed</dt>
            <dd className="text-2xl font-bold">
              <span aria-hidden className="text-green">✓ </span>
              {fixed}
            </dd>
          </div>
          <div className="rounded-xl bg-surface-2 p-3">
            <dt className="text-xs text-muted">Time</dt>
            <dd className="text-lg font-bold">{formatDuration(durationMs)}</dd>
          </div>
          <div className="rounded-xl bg-surface-2 p-3">
            <dt className="text-xs text-muted">Streak</dt>
            <dd className="text-lg font-bold">{streak !== null ? `${streak} day${streak === 1 ? "" : "s"}` : "—"}</dd>
          </div>
        </dl>
        <p className="mt-4 text-sm">
          {coveredNow} of {total} ideas covered on your last try.
        </p>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {(["green", "amber", "red"] as Mastery[])
            .filter((m) => masteryCounts[m] > 0)
            .map((m) => (
              <span key={m} className="inline-flex items-center gap-1 text-sm">
                <MasteryBadge mastery={m} /> × {masteryCounts[m]}
              </span>
            ))}
        </div>
      </div>

      {returnTo && (
        <div className="card border-accent/50 text-center">
          <p>
            Root gap fixed. Ready to go back to <strong>{returnTo.name}</strong>?
          </p>
          <Link href={`/session/${returnTo.id}`} className="btn-primary mt-3 w-full py-3 text-base">
            Back to {returnTo.name}
          </Link>
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        {gapsLeft > 0 && (
          <button type="button" className="btn-primary py-3 text-base sm:col-span-2" onClick={onBuddyAgain}>
            Fix the {gapsLeft} remaining gap{gapsLeft === 1 ? "" : "s"} (new analogy)
          </button>
        )}
        {next && (
          <Link href={`/session/${next.topicId}`} className={`${gapsLeft > 0 || returnTo ? "btn-ghost" : "btn-primary"} py-3 text-base`}>
            Next: {next.name}
          </Link>
        )}
        <Link href="/home" className="btn-ghost py-3 text-base">
          Back to heatmap
        </Link>
        <button type="button" className="btn-ghost py-3 text-base" onClick={onStartAgain}>
          Start again
        </button>
      </div>
      {next?.reason && <p className="muted text-center">{next.reason}</p>}
    </section>
  );
}
