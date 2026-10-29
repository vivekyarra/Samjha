"use client";
export default function PanelError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="p-4 space-y-3" role="alert">
      <p>Something went wrong loading the panel.</p>
      <button onClick={reset} className="rounded-lg border border-[var(--line)] px-3 py-1.5">Try again</button>
    </main>
  );
}
