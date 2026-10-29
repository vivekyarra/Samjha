"use client";
import { useVoice } from "@/lib/voice/context";
import { RichText } from "./RichText";
import { segmentRaw, toSpeech } from "./text";
import type { BuddyStream } from "./useBuddyStream";

const CHIPS: { label: string; say: string }[] = [
  { label: "Wait, why?", say: "wait, why?" },
  { label: "Give me an example", say: "give me an example" },
  { label: "Shorter", say: "shorter" },
  { label: "I still don't get it", say: "I still don't get it" },
];

export function BuddyPanel({
  buddy,
  note,
  onExplainBack,
}: {
  buddy: BuddyStream;
  note?: string | null;
  onExplainBack: () => void;
}) {
  const voice = useVoice();
  const { batches, activeBatch, unspoken, streaming, error, history } = buddy;
  const empty = !batches.length && !unspoken.trim();

  return (
    <section className="space-y-3" aria-label="Buddy">
      {history.length > 0 && (
        <details className="card text-sm">
          <summary className="cursor-pointer text-muted">Earlier in this chat ({history.length})</summary>
          <div className="mt-2 space-y-3">
            {history.map((h, i) => (
              <div key={i} className="whitespace-pre-wrap break-words text-muted">
                <RichText text={h.text} />
              </div>
            ))}
          </div>
        </details>
      )}

      {note && (
        <p className="rounded-xl bg-surface-2 px-3 py-2 text-sm" role="status">
          {note}
        </p>
      )}

      <div className="card" aria-live="polite" aria-busy={streaming}>
        <div className="mb-2 flex items-center gap-2 text-sm text-muted">
          <span className={`inline-block size-2 rounded-full ${streaming || voice.speaking ? "animate-pulse bg-accent" : "bg-line"}`} aria-hidden />
          {streaming ? "Buddy is explaining…" : voice.speaking ? "Reading aloud… say anything to interrupt" : "Buddy"}
        </div>
        {empty && streaming && (
          <div className="space-y-2" aria-hidden>
            <div className="h-6 w-11/12 animate-pulse rounded bg-surface-2" />
            <div className="h-6 w-9/12 animate-pulse rounded bg-surface-2" />
          </div>
        )}
        <div className="buddy-text whitespace-pre-wrap break-words">
          {batches.map((b, bi) => {
            const segs = segmentRaw(b, voice.sentences(toSpeech(b)));
            const active = bi === activeBatch && voice.speaking ? voice.sentenceIndex : -1;
            return segs.map((seg, si) => (
              <span key={`${bi}-${si}`} className={si === active ? "sentence-active" : undefined}>
                <RichText text={seg} />
              </span>
            ));
          })}
          {unspoken && (
            <span className={streaming ? "opacity-80" : undefined}>
              <RichText text={unspoken} />
            </span>
          )}
        </div>
        {error && (
          <div className="mt-3 rounded-xl border border-red/40 bg-red-soft p-3 text-sm" role="alert">
            <p>{error}</p>
            <button type="button" className="btn-ghost mt-2" onClick={buddy.retry}>
              Try again
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2" aria-label="Interrupt the buddy">
        {CHIPS.map((c) => (
          <button key={c.label} type="button" className="btn-ghost" onClick={() => voice.submit(c.say)}>
            “{c.label}”
          </button>
        ))}
        {voice.speaking && (
          <button type="button" className="btn-ghost" onClick={() => buddy.silence()}>
            Stop
          </button>
        )}
      </div>

      <button type="button" className="btn-primary w-full py-3 text-base" onClick={onExplainBack}>
        Now explain it back
      </button>
    </section>
  );
}
