"use client";
export default function ExamEveError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="card mx-auto max-w-xl space-y-3 text-center">
      <p className="h2">Exam-eve mode hit a snag</p>
      <p className="muted">Your progress is saved. Try again.</p>
      <button className="btn-primary" onClick={reset}>Try again</button>
    </div>
  );
}
