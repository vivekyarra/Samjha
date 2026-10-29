import { Spinner } from "@/components/ui";

export default function Loading() {
  return (
    <div className="flex flex-col gap-5" aria-busy>
      <div className="flex items-center justify-between">
        <div className="h-8 w-40 animate-pulse rounded-lg bg-surface-2" />
        <div className="h-7 w-24 animate-pulse rounded-full bg-surface-2" />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="card h-36 animate-pulse" />
        <div className="card h-36 animate-pulse" />
      </div>
      <Spinner label="Loading your heatmap…" />
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-2xl bg-surface-2" />
        ))}
      </div>
    </div>
  );
}
