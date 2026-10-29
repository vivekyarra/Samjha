export default function Loading() {
  return (
    <div className="card mx-auto mt-6 max-w-md space-y-3" aria-busy="true">
      <div className="h-4 w-28 animate-pulse rounded bg-surface-2" />
      <div className="h-7 w-48 animate-pulse rounded bg-surface-2" />
      <div className="h-10 w-full animate-pulse rounded-xl bg-surface-2" />
    </div>
  );
}
