export default function Loading() {
  return (
    <div className="space-y-3" aria-busy="true">
      <div className="h-7 w-56 animate-pulse rounded-lg bg-surface-2" />
      <div className="h-[60vh] animate-pulse rounded-2xl bg-surface-2" />
      <p className="muted">Drawing your concept graph…</p>
    </div>
  );
}
