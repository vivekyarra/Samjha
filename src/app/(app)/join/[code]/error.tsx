"use client";
export default function JoinError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="card mx-auto mt-8 max-w-md space-y-3 text-center" role="alert">
      <p className="h2">Couldn&apos;t open this invite</p>
      <p className="muted">Please try again in a moment.</p>
      <button type="button" className="btn-primary" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
