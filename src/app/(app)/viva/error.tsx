"use client";
export default function VivaError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="card mx-auto max-w-xl text-center" role="alert">
      <p className="font-semibold"><span aria-hidden>✗ </span>The examiner hit a snag</p>
      <p className="muted mt-1">{error.message || "Something went wrong loading the viva."}</p>
      <button className="btn-primary mt-3" onClick={reset}>Try again</button>
    </div>
  );
}
