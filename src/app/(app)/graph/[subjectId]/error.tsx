"use client";
export default function GraphError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="card mx-auto max-w-xl space-y-3 text-center">
      <p className="h2">Couldn&apos;t load the graph</p>
      <p className="muted">Something went wrong while reading your topics. Your progress is safe.</p>
      <button className="btn-primary" onClick={reset}>Try again</button>
    </div>
  );
}
