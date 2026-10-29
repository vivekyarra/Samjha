export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading topics">
      <div className="space-y-2">
        <div className="h-8 w-64 max-w-full animate-pulse rounded-lg bg-surface-2" />
        <div className="h-4 w-40 animate-pulse rounded bg-surface-2" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="card h-24 animate-pulse bg-surface-2" />
        ))}
      </div>
    </div>
  );
}
