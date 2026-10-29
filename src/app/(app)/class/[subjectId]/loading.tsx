export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading class view">
      <div className="space-y-2">
        <div className="h-4 w-24 animate-pulse rounded bg-surface-2" />
        <div className="h-7 w-40 animate-pulse rounded bg-surface-2" />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="card h-40 animate-pulse" />
        <div className="card h-40 animate-pulse" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="card h-28 animate-pulse" />
        ))}
      </div>
      <p className="muted">Combining the class&apos;s results…</p>
    </div>
  );
}
