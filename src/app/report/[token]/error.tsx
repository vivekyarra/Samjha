"use client";
export default function ReportError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto w-full max-w-md px-4 py-16">
      <div className="card space-y-3 text-center" role="alert">
        <p className="h2">Couldn&apos;t load this report</p>
        <button type="button" className="btn-primary" onClick={reset}>
          Try again
        </button>
      </div>
    </main>
  );
}
