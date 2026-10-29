"use client";
export default function ClassError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="card mx-auto mt-8 max-w-md space-y-3 text-center" role="alert">
      <p className="h2">Couldn&apos;t load the class view</p>
      <p className="muted">Something went wrong while combining results. Your own study data is safe.</p>
      <button type="button" className="btn-primary" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
