"use client";
import Link from "next/link";
import type { Scorecard, Verdict } from "@/lib/viva/types";
import { personaLabel } from "@/lib/viva/types";

const VERDICT: Record<Verdict, { icon: string; label: string; cls: string }> = {
  strong: { icon: "✓", label: "Strong", cls: "bg-green-soft text-green" },
  partial: { icon: "◐", label: "Partial", cls: "bg-amber-soft text-amber" },
  weak: { icon: "✗", label: "Weak", cls: "bg-red-soft text-red" },
  skipped: { icon: "–", label: "Skipped", cls: "bg-surface-2 text-muted" },
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const v = VERDICT[verdict];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${v.cls}`}>
      <span aria-hidden>{v.icon}</span>
      {v.label}
    </span>
  );
}

function scoreBand(n: number): { label: string; cls: string; icon: string } {
  if (n >= 70) return { label: "Ready", cls: "text-green", icon: "✓" };
  if (n >= 40) return { label: "Getting there", cls: "text-amber", icon: "◐" };
  return { label: "Needs work", cls: "text-red", icon: "✗" };
}

export function ScorecardView({ sc, onRestart }: { sc: Scorecard; onRestart?: () => void }) {
  const band = scoreBand(sc.overall);
  const mins = Math.floor(sc.durationSec / 60);
  const secs = sc.durationSec % 60;
  return (
    <div className="space-y-4">
      <section className="card flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex items-baseline gap-2">
          <span className="text-5xl font-bold tabular-nums">{sc.overall}</span>
          <span className="muted">/ 100</span>
        </div>
        <div className="flex-1 sm:pl-4">
          <p className={`font-semibold ${band.cls}`}>
            <span aria-hidden>{band.icon}</span> {band.label}
          </p>
          <p className="mt-1">{sc.summary}</p>
          <p className="muted mt-1">
            {personaLabel(sc.persona)} · {mins}m {secs}s · {sc.items.length} answer{sc.items.length === 1 ? "" : "s"}
          </p>
        </div>
      </section>

      {sc.prepare.length > 0 && (
        <section className="card">
          <h2 className="h2">{sc.mode === "placement" ? "Three answers to prepare better" : "Revise these before the real viva"}</h2>
          <ol className="mt-3 space-y-3">
            {sc.prepare.map((p, i) => (
              <li key={i} className="rounded-xl bg-surface-2 p-3">
                <p className="font-medium">
                  {i + 1}. {p.question}
                </p>
                <p className="muted mt-1">{p.why}</p>
                {p.outline && <p className="mt-2 text-sm"><span className="font-semibold">Practise: </span>{p.outline}</p>}
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="h2">Question by question</h2>
        {sc.items.length === 0 && <p className="muted card">No answers were recorded in this session.</p>}
        {sc.items.map((it, i) => (
          <article key={i} className={`card ${it.isFollowUp ? "ml-4 border-dashed" : ""}`}>
            <div className="flex items-start justify-between gap-3">
              <p className="font-medium">
                {it.isFollowUp && <span className="muted mr-1">Follow-up:</span>}
                {it.question}
              </p>
              <VerdictBadge verdict={it.verdict} />
            </div>
            {it.answer && (
              <details className="mt-2">
                <summary className="muted cursor-pointer">Your answer</summary>
                <p className="mt-1 whitespace-pre-wrap text-sm">{it.answer}</p>
              </details>
            )}
            {it.strong.length > 0 && (
              <ul className="mt-2 space-y-1 text-sm">
                {it.strong.map((s, j) => (
                  <li key={j} className="flex gap-2"><span className="text-green" aria-label="strong">✓</span><span>{s}</span></li>
                ))}
              </ul>
            )}
            {it.missing.length > 0 && (
              <ul className="mt-2 space-y-1 text-sm">
                {it.missing.map((s, j) => (
                  <li key={j} className="flex gap-2"><span className="text-red" aria-label="missing">✗</span><span>{s}</span></li>
                ))}
              </ul>
            )}
            {it.citations.length > 0 && (
              <p className="mt-2 flex flex-wrap gap-2 text-xs">
                {it.citations.map((c, j) => (
                  <Link key={j} href={c.href} className="rounded-full border border-line px-2 py-0.5 text-accent hover:bg-surface-2">
                    {c.label}
                  </Link>
                ))}
              </p>
            )}
          </article>
        ))}
      </section>

      <div className="flex flex-wrap gap-2">
        {onRestart ? (
          <button className="btn-primary" onClick={onRestart}>Start another</button>
        ) : (
          <Link href="/viva" className="btn-primary">Start another</Link>
        )}
        <Link href="/viva" className="btn-ghost">All vivas</Link>
      </div>
    </div>
  );
}
