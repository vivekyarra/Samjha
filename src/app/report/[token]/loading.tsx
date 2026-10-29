export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-4xl space-y-4 px-4 py-6" aria-busy="true">
      <div className="h-7 w-56 animate-pulse rounded bg-surface-2" />
      <div className="card h-16 animate-pulse" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="card h-28 animate-pulse" />
        ))}
      </div>
    </main>
  );
}
