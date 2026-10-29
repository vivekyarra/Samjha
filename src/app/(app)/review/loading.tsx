import { Spinner } from "@/components/ui";

export default function Loading() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4" aria-busy>
      <div className="h-8 w-48 animate-pulse rounded-lg bg-surface-2" />
      <Spinner label="Checking what's due…" />
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="card h-16 animate-pulse" />
      ))}
    </div>
  );
}
