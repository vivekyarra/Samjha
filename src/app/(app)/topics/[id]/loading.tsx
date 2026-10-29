export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-5" aria-busy="true" aria-label="Loading topic">
      <div className="space-y-2">
        <div className="h-4 w-28 animate-pulse rounded bg-surface-2" />
        <div className="h-8 w-2/3 animate-pulse rounded bg-surface-2" />
      </div>
      <div className="h-12 animate-pulse rounded-xl bg-surface-2" />
      <div className="card space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-xl bg-surface-2" />
        ))}
      </div>
    </div>
  );
}
