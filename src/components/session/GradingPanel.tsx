"use client";

export function GradingPanel({ error, onRetry, onEdit }: { error: string | null; onRetry: () => void; onEdit: () => void }) {
  if (error) {
    return (
      <div className="card space-y-3 border-red/40" role="alert">
        <h2 className="h2">Couldn&apos;t check that one</h2>
        <p className="text-sm">{error}</p>
        <p className="muted">Your explanation is saved here, nothing is lost.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary" onClick={onRetry}>
            Try again
          </button>
          <button type="button" className="btn-ghost" onClick={onEdit}>
            Explain again
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="card space-y-4" aria-busy="true" aria-live="polite">
      <div className="flex items-center gap-3">
        <span className="inline-block size-5 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden />
        <p className="font-medium">Checking your explanation against your notes…</p>
      </div>
      <div className="space-y-2" aria-hidden>
        {[92, 80, 86, 60].map((w, i) => (
          <div key={i} className="h-4 animate-pulse rounded bg-surface-2" style={{ width: `${w}%`, animationDelay: `${i * 120}ms` }} />
        ))}
      </div>
      <div className="space-y-2" aria-hidden>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-12 animate-pulse rounded-xl bg-surface-2" style={{ animationDelay: `${i * 150}ms` }} />
        ))}
      </div>
    </div>
  );
}
