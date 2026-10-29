export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4" aria-busy="true" aria-label="Loading session">
      <div className="h-5 w-40 animate-pulse rounded bg-surface-2" />
      <div className="card space-y-3">
        <div className="mx-auto h-4 w-24 animate-pulse rounded bg-surface-2" />
        <div className="mx-auto h-7 w-11/12 animate-pulse rounded bg-surface-2" />
        <div className="mx-auto h-7 w-8/12 animate-pulse rounded bg-surface-2" />
      </div>
      <p className="muted text-center">Getting your topic ready…</p>
    </div>
  );
}
