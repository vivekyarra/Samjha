export default function Loading() {
  return (
    <div className="mx-auto max-w-3xl space-y-4" aria-busy="true" aria-label="Loading page">
      <div className="h-6 w-56 max-w-full animate-pulse rounded bg-surface-2" />
      <div className="card h-80 animate-pulse bg-surface-2" />
    </div>
  );
}
