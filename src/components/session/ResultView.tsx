"use client";
import { useEffect, useState, type ReactNode } from "react";
import { MasteryBadge } from "@/components/ui/MasteryBadge";
import type { ClaimGrade, ClaimStatus, GradeResult } from "@/lib/types";
import type { AttemptRecord, SessionClaim } from "./types";
import { CiteChip } from "./RichText";
import { citeHref, findMarks } from "./text";

const STATUS: Record<ClaimStatus, { icon: string; label: string; row: string; chip: string }> = {
  covered: { icon: "✓", label: "Covered", row: "border-green/40 bg-green-soft", chip: "bg-green text-white" },
  wrong: { icon: "✗", label: "Wrong", row: "border-red/40 bg-red-soft", chip: "bg-red text-white" },
  missing: { icon: "?", label: "Missing", row: "border-line bg-surface-2", chip: "bg-muted text-bg" },
};

function StatusChip({ status }: { status: ClaimStatus }) {
  const s = STATUS[status];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold transition-colors duration-700 ${s.chip}`}>
      <span aria-hidden>{s.icon}</span>
      {s.label}
    </span>
  );
}

/** The student's explanation with evidence phrases highlighted (green ✓ covered, red ✗ wrong). */
export function HighlightedExplanation({ explanation, result, numberOf }: { explanation: string; result: GradeResult; numberOf: (claimId: string) => number }) {
  const marks = findMarks(explanation, [
    ...result.claims.filter((c) => c.status === "wrong" && c.evidence).map((c) => ({ phrase: c.evidence, kind: "wrong" as const, claimNo: numberOf(c.claim_id) })),
    ...result.misconceptions.filter((m) => m.quote).map((m) => ({ phrase: m.quote, kind: "wrong" as const })),
    ...result.claims.filter((c) => c.status === "covered" && c.evidence).map((c) => ({ phrase: c.evidence, kind: "covered" as const, claimNo: numberOf(c.claim_id) })),
  ]);
  const parts: ReactNode[] = [];
  let i = 0;
  marks.forEach((m, k) => {
    if (m.start > i) parts.push(<span key={`t${k}`}>{explanation.slice(i, m.start)}</span>);
    const cov = m.kind === "covered";
    parts.push(
      <mark
        key={`m${k}`}
        className={`rounded px-0.5 text-fg ${cov ? "bg-green-soft underline decoration-green decoration-2 underline-offset-4" : "bg-red-soft underline decoration-red decoration-wavy decoration-2 underline-offset-4"}`}
        title={cov ? "Covered" : "Wrong"}
      >
        {explanation.slice(m.start, m.end)}
        <sup className={`ml-0.5 font-bold ${cov ? "text-green" : "text-red"}`} aria-label={cov ? "covered" : "wrong"}>
          {cov ? "✓" : "✗"}
          {m.claimNo ? m.claimNo : ""}
        </sup>
      </mark>,
    );
    i = m.end;
  });
  if (i < explanation.length) parts.push(<span key="end">{explanation.slice(i)}</span>);
  return <p className="whitespace-pre-wrap break-words leading-relaxed">{parts}</p>;
}

function ClaimRow({
  no,
  claim,
  grade,
  prevStatus,
  mastery,
  delay,
  attemptId,
  onAppeal,
}: {
  no: number;
  claim: SessionClaim;
  grade: ClaimGrade;
  prevStatus?: ClaimStatus;
  mastery?: SessionClaim["mastery"];
  delay: number;
  attemptId: string;
  onAppeal: (claimId: string, note: string) => Promise<void>;
}) {
  const flips = !!prevStatus && prevStatus !== grade.status;
  const [shown, setShown] = useState<ClaimStatus>(flips ? prevStatus! : grade.status);
  const [appealOpen, setAppealOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [appealMsg, setAppealMsg] = useState<string | null>(null);

  // When the grade (or its starting point) changes, restart from the right status during render.
  const [flipFrom, setFlipFrom] = useState({ flips, prevStatus, status: grade.status, delay });
  if (flipFrom.flips !== flips || flipFrom.prevStatus !== prevStatus || flipFrom.status !== grade.status || flipFrom.delay !== delay) {
    setFlipFrom({ flips, prevStatus, status: grade.status, delay });
    setShown(flips ? prevStatus! : grade.status);
  }

  useEffect(() => {
    if (!flips) return;
    const t = setTimeout(() => setShown(grade.status), 600 + delay);
    return () => clearTimeout(t);
  }, [flips, prevStatus, grade.status, delay]);

  const href = citeHref(claim.source_id, grade.page ?? claim.page);
  const page = grade.page ?? claim.page;

  async function submitAppeal() {
    setBusy(true);
    setAppealMsg(null);
    try {
      await onAppeal(claim.id, note.trim());
      setAppealOpen(false);
      setAppealMsg("Re-checked with your note.");
    } catch (e) {
      setAppealMsg(e instanceof Error && /try again|signed out|shared/.test(e.message) ? e.message : "Couldn't re-check right now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`rounded-xl border p-3 transition-colors duration-700 ${STATUS[shown].row}`} data-attempt={attemptId}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 w-5 shrink-0 text-sm font-semibold text-muted">{no}.</span>
        <div className="min-w-0 flex-1">
          <p className="break-words">{claim.text}</p>
          {grade.status === "wrong" && grade.evidence && (
            <p className="mt-1 text-sm">
              <span className="font-medium text-red">You said:</span> “{grade.evidence}”
            </p>
          )}
          {grade.status === "wrong" && grade.correction && (
            <p className="mt-1 text-sm">
              <span className="font-medium">Your notes say:</span> {grade.correction}
            </p>
          )}
          {grade.status === "covered" && grade.evidence && <p className="mt-1 text-sm text-muted">“{grade.evidence}”</p>}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusChip status={shown} />
            {flips && shown === "covered" && <span className="text-xs font-semibold text-green">Fixed!</span>}
            {mastery && <MasteryBadge mastery={mastery} />}
            {href && <CiteChip href={href} label={page ? `p.${page}` : "notes"} />}
            {grade.status !== "covered" && !appealOpen && (
              <button type="button" className="ml-auto text-xs text-muted underline hover:text-fg" data-voice-keep-focus onClick={() => setAppealOpen(true)}>
                This is right
              </button>
            )}
          </div>
          {appealOpen && (
            <div className="mt-2 space-y-2">
              <label className="muted block" htmlFor={`appeal-${claim.id}`}>
                Why is your explanation right here? (optional)
              </label>
              <textarea data-voice-keep-focus id={`appeal-${claim.id}`} className="input min-h-16 text-sm" value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="flex gap-2">
                <button type="button" data-voice-keep-focus className="btn-primary" disabled={busy} onClick={submitAppeal}>
                  {busy ? "Re-checking…" : "Re-check"}
                </button>
                <button type="button" className="btn-ghost" onClick={() => setAppealOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {appealMsg && <p className="mt-1 text-xs text-muted" role="status">{appealMsg}</p>}
        </div>
      </div>
    </li>
  );
}

export function ResultView({
  claims,
  attempt,
  prev,
  primarySourceId,
  onAppeal,
  compact,
}: {
  claims: SessionClaim[];
  attempt: AttemptRecord;
  prev?: AttemptRecord;
  primarySourceId: string | null;
  onAppeal: (claimId: string, note: string) => Promise<void>;
  compact?: boolean;
}) {
  const { result } = attempt;
  const byId = new Map(claims.map((c, i) => [c.id, { claim: c, no: i + 1 }]));
  const numberOf = (id: string) => byId.get(id)?.no ?? 0;
  const prevStatus = new Map(prev?.result.claims.map((c) => [c.claim_id, c.status]) ?? []);
  const graded = result.claims.filter((g) => byId.has(g.claim_id)).sort((a, b) => numberOf(a.claim_id) - numberOf(b.claim_id));
  const order: Record<ClaimStatus, number> = { wrong: 0, missing: 1, covered: 2 };
  const sorted = prev ? graded : [...graded].sort((a, b) => order[a.status] - order[b.status] || numberOf(a.claim_id) - numberOf(b.claim_id));
  const covered = graded.filter((g) => g.status === "covered").length;
  let flipIdx = 0;

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="h2">{prev ? "Your explain-back" : "Your explanation"}</h2>
          <p className="text-sm font-medium" aria-live="polite">
            {covered} of {graded.length} ideas covered
          </p>
        </div>
        <div className="mt-3 text-base">
          <HighlightedExplanation explanation={attempt.explanation} result={result} numberOf={numberOf} />
        </div>
        <p className="mt-3 flex flex-wrap gap-3 text-xs text-muted">
          <span><span className="font-bold text-green">✓</span> covered</span>
          <span><span className="font-bold text-red">✗</span> wrong</span>
          <span>numbers match the list below</span>
        </p>
      </div>

      <div className="card">
        <h2 className="h2">Key ideas</h2>
        <ul className="mt-3 space-y-2">
          {sorted.map((g) => {
            const entry = byId.get(g.claim_id)!;
            const ps = prevStatus.get(g.claim_id);
            const delay = ps && ps !== g.status ? flipIdx++ * 350 : 0;
            return (
              <ClaimRow
                key={`${attempt.attemptId}-${g.claim_id}`}
                no={entry.no}
                claim={entry.claim}
                grade={g}
                prevStatus={ps}
                mastery={attempt.mastery[g.claim_id]}
                delay={delay}
                attemptId={attempt.attemptId}
                onAppeal={onAppeal}
              />
            );
          })}
        </ul>
      </div>

      {!compact && result.misconceptions.length > 0 && (
        <div className="card">
          <h2 className="h2">Misconceptions</h2>
          <ul className="mt-3 space-y-3">
            {result.misconceptions.map((m, i) => {
              const href = citeHref(primarySourceId, m.page);
              return (
                <li key={i} className="rounded-xl border border-red/40 bg-red-soft p-3 text-sm">
                  <p>
                    <span aria-hidden className="font-bold text-red">✗ </span>
                    <span className="font-medium">“{m.quote}”</span>
                  </p>
                  <p className="mt-1">
                    {m.correction} {href && <CiteChip href={href} label={m.page ? `p.${m.page}` : "notes"} />}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {!compact && (result.not_in_notes?.length ?? 0) > 0 && (
        <div className="card">
          <h2 className="h2">Not in your notes</h2>
          <p className="muted mt-1">You said these, but your notes don&apos;t cover them, so they weren&apos;t graded.</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            {result.not_in_notes!.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      {!compact && result.strengths.length > 0 && (
        <div className="card">
          <h2 className="h2">What you nailed</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {result.strengths.map((s, i) => (
              <li key={i}>
                <span aria-hidden className="font-bold text-green">✓ </span>
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
