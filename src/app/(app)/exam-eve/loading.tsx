export default function Loading() {
  return (
    <div className="mx-auto max-w-xl space-y-3" aria-busy="true">
      <div className="h-7 w-48 animate-pulse rounded-lg bg-surface-2" />
      <div className="h-24 animate-pulse rounded-2xl bg-surface-2" />
      <div className="h-40 animate-pulse rounded-2xl bg-surface-2" />
    </div>
  );
}
