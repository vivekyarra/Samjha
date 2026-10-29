"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClaimGrade, GradeResult, Mastery } from "@/lib/types";

export interface PanelClaim { id: string; text: string; page: number | null; source_id: string | null }
type Phase = "explain" | "grading" | "result" | "buddy" | "explain_back" | "done";
type BuddyMode = "gaps" | "example" | "shorter" | "stuck";

const AUTO_SUBMIT_MS = 1500;
const MIN_WORDS = 8;
const ICON: Record<ClaimGrade["status"], string> = { covered: "✓", wrong: "✗", missing: "○" };
const LABEL: Record<ClaimGrade["status"], string> = { covered: "Covered", wrong: "Wrong", missing: "Missing" };
const TONE: Record<ClaimGrade["status"], string> = { covered: "bg-[var(--green-soft)]", wrong: "bg-[var(--red-soft)]", missing: "bg-[var(--amber-soft)]" };

function splitSentences(t: string) {
  return t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").match(/[^.!?\n]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
}

export default function PanelClient({ topicId, topicName, claims }: { topicId: string; topicName: string; claims: PanelClaim[] }) {
  const [phase, setPhase] = useState<Phase>("explain");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [grades, setGrades] = useState<ClaimGrade[]>([]);
  const [misconceptions, setMisconceptions] = useState<GradeResult["misconceptions"]>([]);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [buddy, setBuddy] = useState("");
  const [rounds, setRounds] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abort = useRef<AbortController | null>(null);
  const claimText = new Map(claims.map((c) => [c.id, c]));

  const stopSpeech = () => { if (typeof window !== "undefined") window.speechSynthesis?.cancel(); };
  const speak = (text: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    for (const s of splitSentences(text)) window.speechSynthesis.speak(new SpeechSynthesisUtterance(s));
  };

  useEffect(() => {
    speak(`Explain ${topicName} like you're teaching a junior. Take your time.`);
    return () => { stopSpeech(); abort.current?.abort(); if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runBuddy = useCallback(async (aId: string, mode: BuddyMode) => {
    stopSpeech();
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setPhase("buddy");
    setBuddy("");
    setError(null);
    try {
      const res = await fetch("/api/buddy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topicId, attemptId: aId, mode }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error || "The buddy couldn't answer.");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let full = "";
      let spoken = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        full += dec.decode(value, { stream: true });
        setBuddy(full);
        const sentences = splitSentences(full);
        const complete = /[.!?\n]\s*$/.test(full) ? sentences.length : sentences.length - 1;
        if (complete > spoken) { speak(sentences.slice(spoken, complete).join(" ")); spoken = complete; }
      }
      const rest = splitSentences(full).slice(spoken).join(" ");
      if (rest) speak(rest);
      setRounds((r) => r + 1);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    }
  }, [topicId]);

  const submit = useCallback(async (text: string) => {
    if (timer.current) clearTimeout(timer.current);
    const explanation = text.trim();
    if (!explanation || phase === "grading") return;
    const kind = phase === "explain_back" ? "explain_back" : "explain";
    stopSpeech();
    setPhase("grading");
    setError(null);
    try {
      const res = await fetch("/api/grade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topicId, explanation, kind, parentAttemptId: kind === "explain_back" ? attemptId : undefined, afterBuddy: kind === "explain_back" }),
      });
      const data = (await res.json()) as { attemptId?: string; result?: GradeResult; mastery?: Record<string, Mastery>; error?: string };
      if (!res.ok || !data.result || !data.attemptId) throw new Error(data.error || "Grading failed.");
      setAttemptId(data.attemptId);
      setGrades(data.result.claims);
      setMisconceptions(data.result.misconceptions);
      setDraft("");
      const gaps = data.result.claims.filter((c) => c.status !== "covered").length;
      if (!gaps) {
        setPhase("done");
        speak("Every point covered. Nice work.");
      } else {
        setPhase("result");
        speak(`You covered ${data.result.claims.length - gaps} of ${data.result.claims.length}. Let me explain the rest.`);
        void runBuddy(data.attemptId, "gaps");
      }
    } catch (e) {
      setPhase(kind === "explain_back" ? "explain_back" : "explain");
      setError((e as Error).message);
    }
  }, [attemptId, phase, runBuddy, topicId]);

  function onDraft(v: string) {
    setDraft(v);
    stopSpeech();
    if (timer.current) clearTimeout(timer.current);
    if (v.trim().split(/\s+/).length >= MIN_WORDS) timer.current = setTimeout(() => submit(v), AUTO_SUBMIT_MS);
  }

  const writing = phase === "explain" || phase === "explain_back";

  return (
    <main className="p-3 space-y-3 max-w-xl mx-auto">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-base font-semibold truncate">{topicName}</h1>
        <a href={`/topics/${topicId}`} target="_blank" rel="noreferrer" className="text-sm underline shrink-0">Open in Samjha</a>
      </header>

      {grades.length > 0 && (
        <section aria-label="Grade results">
          <ul className="space-y-1.5">
            {grades.map((g) => (
              <li key={g.claim_id} className={`rounded-lg p-2 ${TONE[g.status]}`}>
                <span className="font-medium">{ICON[g.status]} {LABEL[g.status]}:</span> {claimText.get(g.claim_id)?.text ?? ""}
                {g.status !== "covered" && g.correction && <p className="text-sm text-[var(--muted)] mt-0.5">{g.correction}</p>}
              </li>
            ))}
          </ul>
          {misconceptions.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm">
              {misconceptions.map((m, i) => <li key={i}>✗ &ldquo;{m.quote}&rdquo; → {m.correction}</li>)}
            </ul>
          )}
        </section>
      )}

      {(phase === "buddy" || phase === "result") && (
        <section aria-label="Buddy" className="space-y-2">
          <p className="whitespace-pre-wrap rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3 text-lg leading-snug" aria-live="polite">{buddy || "Thinking…"}</p>
          <div className="flex flex-wrap gap-2">
            {attemptId && (["example", "shorter", "stuck"] as const).map((m) => (
              <button key={m} onClick={() => runBuddy(attemptId, m)} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm">
                {m === "example" ? "Give an example" : m === "shorter" ? "Shorter" : "I still don't get it"}
              </button>
            ))}
            <button onClick={() => { stopSpeech(); setPhase("explain_back"); speak("Now explain it back to me."); }} className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm text-[var(--accent-fg)]">Explain it back</button>
          </div>
          {rounds >= 2 && <p className="text-sm text-[var(--muted)]">Still stuck? <a className="underline" target="_blank" rel="noreferrer" href={`/topics/${topicId}`}>Open the full session</a> to trace the root cause.</p>}
        </section>
      )}

      {writing && (
        <section className="space-y-2">
          <label htmlFor="explain" className="block text-sm text-[var(--muted)]">
            {phase === "explain" ? `Explain ${topicName} like you're teaching a junior. Dictate with Wispr; I send after a ${AUTO_SUBMIT_MS / 1000}s pause.` : "Now explain it back to me."}
          </label>
          <textarea id="explain" autoFocus value={draft} onChange={(e) => onDraft(e.target.value)} rows={6}
            className="w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3 text-base" />
          <button onClick={() => submit(draft)} disabled={!draft.trim()} className="rounded-lg bg-[var(--accent)] px-4 py-2 text-[var(--accent-fg)] disabled:opacity-50">Send</button>
        </section>
      )}

      {phase === "grading" && <p role="status" className="text-[var(--muted)]">Checking your explanation…</p>}
      {phase === "done" && <p role="status" className="rounded-lg bg-[var(--green-soft)] p-3">✓ Every point covered. Nice work.</p>}
      {error && <p role="alert" className="rounded-lg bg-[var(--red-soft)] p-2 text-sm">{error}</p>}
    </main>
  );
}
