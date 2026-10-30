"use client";

export function ExplainPanel({
  topicName,
  back,
  reviewCount,
  isDemo,
  suggesting,
  suggestError,
  onSuggest,
  onSkip,
}: {
  topicName: string;
  back: boolean;
  reviewCount?: number;
  isDemo: boolean;
  suggesting: boolean;
  suggestError: string | null;
  onSuggest: () => void;
  onSkip?: () => void;
}) {
  return (
    <section className="space-y-4">
      {isDemo && !back && (
        <div className="rounded-2xl border border-accent/40 bg-accent/10 p-4 text-sm">
          Hold your dictation key and explain <em className="font-semibold">{topicName}</em>. Samjha will find what you missed.
        </div>
      )}
      <div className="card text-center">
        <p className="text-sm uppercase tracking-wide text-muted">{back ? "Your turn again" : reviewCount ? "Quick review" : "Your turn"}</p>
        <p className="buddy-text mt-2 break-words">
          {back ? (
            <>
              Now explain <em className="font-semibold">{topicName}</em> back to me. The whole thing, in your own words.
            </>
          ) : (
            <>
              Explain <em className="font-semibold">{topicName}</em> like you&apos;re teaching a junior. Take your time.
            </>
          )}
        </p>
        {reviewCount ? (
          <p className="muted mt-2">
            {reviewCount} idea{reviewCount === 1 ? "" : "s"} due for review.
          </p>
        ) : null}
        <p className="muted mt-4">
          Speak when you&apos;re ready. Say <strong>“done”</strong> when you&apos;re finished.
        </p>
        <svg aria-hidden className="mx-auto mt-3 animate-bounce text-muted" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M10 3v13M4 10l6 6 6-6" />
        </svg>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {isDemo && !back && (
          <button type="button" className="btn-primary" onClick={onSuggest} disabled={suggesting}>
            {suggesting ? "Loading…" : "Suggested explanation"}
          </button>
        )}
        {onSkip && (
          <button type="button" className="btn-ghost" onClick={onSkip}>
            Skip to summary
          </button>
        )}
      </div>
      {isDemo && !back && <p className="muted text-center">Try a sample explanation: say “suggested explanation”.</p>}
      {suggestError && (
        <p className="text-center text-sm text-red" role="alert">
          {suggestError}
        </p>
      )}
    </section>
  );
}
