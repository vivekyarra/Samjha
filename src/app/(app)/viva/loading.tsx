export default function Loading() {
  return (
    <div className="mx-auto max-w-3xl animate-pulse space-y-4" aria-busy="true" aria-label="Loading viva">
      <div className="h-8 w-2/3 rounded-xl bg-surface-2" />
      <div className="grid grid-cols-2 gap-2">
        <div className="h-20 rounded-2xl bg-surface-2" />
        <div className="h-20 rounded-2xl bg-surface-2" />
      </div>
      <div className="h-64 rounded-2xl bg-surface-2" />
    </div>
  );
}
