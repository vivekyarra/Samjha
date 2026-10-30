"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useVoice, useVoiceScreen } from "@/lib/voice/context";
import type { AnswerResult, Persona, Scorecard, VivaView } from "@/lib/viva/types";
import { PERSONAS, parsePersona, personaLabel } from "@/lib/viva/types";
import { ScorecardView } from "./ScorecardView";

const fmt = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const LEVEL = ["", "Easy", "Medium", "Hard"];

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(j.error || "Something went wrong. Try again.");
  return j;
}

const PERSONA_CMD = /^(?:please\s+)?(?:be\s+(?:a\s+|the\s+)?|switch\s+to\s+(?:a\s+|the\s+)?|change\s+to\s+(?:a\s+|the\s+)?|make\s+it\s+|become\s+(?:a\s+|the\s+)?)?(strict|friendly|fast[- ]?paced|fast)(?:\s+(?:professor|senior|interviewer|mode|examiner))?(?:\s+(?:mode|please))?[.!]?$|^(?:the\s+)?(?:strict\s+)?professor[.!]?$|^(?:friendly\s+)?senior[.!]?$|^(?:fast[- ]?paced\s+)?interviewer[.!]?$/i;

export function VivaSession({ initial }: { initial: VivaView }) {
  const router = useRouter();
  const voice = useVoice();
  const [view, setView] = useState<VivaView>(initial);
  const [feedback, setFeedback] = useState(initial.lastFeedback);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastAnswer, setLastAnswer] = useState<string>("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [qStart, setQStart] = useState(() => Date.now());
  const busyRef = useRef(false);
  const spokenFirst = useRef(false);
  const timeUpFired = useRef(false);
  const qIdRef = useRef(initial.current?.id);

  const done = view.done;
  const q = view.current;
  const remaining = view.endsAt - nowMs;
  const qRemaining = qStart + view.perQuestionSec * 1000 - nowMs;

  useEffect(() => {
    if (done) return;
    const t = setInterval(() => setNowMs(Date.now()), 500);
    return () => clearInterval(t);
  }, [done]);


  // Read the first question aloud once.
  useEffect(() => {
    if (spokenFirst.current) return;
    spokenFirst.current = true;
    if (!initial.done && initial.current) voice.speak(initial.current.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = useCallback((v: VivaView, line: string, speakText?: string) => {
    // A new question restarts the per-question clock.
    if (v.current?.id !== qIdRef.current) {
      qIdRef.current = v.current?.id;
      setQStart(Date.now());
    }
    setView(v);
    setFeedback(line);
    if (speakText) voice.speak(speakText);
  }, [voice]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Something went wrong.";
      setError(msg);
      voice.speak(msg);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [voice]);

  const submitAnswer = useCallback((text: string) => run(async () => {
    voice.stop();
    setLastAnswer(text);
    const r = await post<AnswerResult>(`/api/viva/${view.id}/answer`, { text });
    const scoreLine = r.done && r.view.scorecard ? ` ${r.view.scorecard.summary}` : "";
    apply(r.view, r.feedbackLine, r.done ? `${r.feedbackLine}${scoreLine}` : `${r.feedbackLine} ${r.nextQuestion?.text ?? ""}`);
  }), [run, voice, view.id, apply]);

  const end = useCallback((reason?: string) => run(async () => {
    voice.stop();
    const r = await post<{ scorecard: Scorecard; view: VivaView }>(`/api/viva/${view.id}/end`, {});
    const line = `${reason ? reason + " " : ""}Your score is ${r.scorecard.overall} out of 100. ${r.scorecard.summary}`;
    apply(r.view, line, line);
  }), [run, voice, view.id, apply]);

  const changePersona = useCallback((persona: Persona) => run(async () => {
    const r = await post<{ view: VivaView; line: string }>(`/api/viva/${view.id}/persona`, { persona });
    apply(r.view, r.line, `${r.line} ${r.view.current?.text ?? ""}`);
  }), [run, view.id, apply]);

  const changeDifficulty = useCallback((difficulty: "harder" | "easier") => run(async () => {
    const r = await post<{ view: VivaView; line: string }>(`/api/viva/${view.id}/persona`, { difficulty });
    apply(r.view, r.line, `${r.line} ${r.view.current?.text ?? ""}`);
  }), [run, view.id, apply]);

  const repeat = useCallback(() => {
    if (q) voice.speak(q.text);
  }, [q, voice]);

  // Overall time up → end the viva.
  useEffect(() => {
    if (!done && remaining <= 0 && !busyRef.current && !timeUpFired.current) {
      timeUpFired.current = true;
      void end("Time's up.");
    }
  }, [done, remaining, end]);

  // Fast-paced interviewer: per-question clock moves on automatically.
  useEffect(() => {
    if (!done && view.persona === "fast" && q && qRemaining <= 0 && remaining > 0 && !busyRef.current && !voice.speaking) {
      setQStart(Date.now());
      void submitAnswer("skip");
    }
  }, [done, view.persona, q, qRemaining, remaining, voice.speaking, submitAnswer]);

  useVoiceScreen({
    mode: done ? "browse" : "viva",
    hint: done
      ? "Say “read my score”, “start another viva” or “show history”."
      : busy
        ? "Examiner is thinking…"
        : "Answer out loud. Commands: “repeat”, “skip”, “harder”, “easier”, “strict professor”, “end viva”.",
    onInput: (text, intent) => {
      const t = text.toLowerCase().trim().replace(/[.!?]+$/, "");
      const short = t.split(/\s+/).length <= 6;
      if (done) {
        if (/\b(read|tell|what'?s)\b.*\b(score|result|scorecard)\b|^my score$/.test(t)) {
          const sc = view.scorecard;
          if (sc) voice.speak(`You scored ${sc.overall} out of 100. ${sc.summary}${sc.prepare[0] ? ` First thing to prepare: ${sc.prepare[0].question}` : ""}`);
          return true;
        }
        if (/\b(another|new|again|restart)\b/.test(t) || /^(show )?(history|all vivas)$/.test(t)) {
          router.push("/viva");
          return true;
        }
        return false;
      }
      if (short && /^(end|stop|finish|quit)( the| my| this)? (viva|interview|session|exam)|^(i'?m|i am) (done|finished)( with the viva)?$|^end( it)?$/.test(t)) {
        void end();
        return true;
      }
      if (short && /^(make it |go |a bit |little )?(harder|tougher|more difficult|ask harder( questions)?)( please)?$/.test(t)) {
        void changeDifficulty("harder");
        return true;
      }
      if (short && /^(make it |go |a bit |little )?(easier|simpler|too hard|that'?s too hard)( please)?$/.test(t)) {
        void changeDifficulty("easier");
        return true;
      }
      if (short && /^(repeat|repeat (that|the question|please)|say (that|it) again|come again|pardon|what was the question)$/.test(t)) {
        repeat();
        return true;
      }
      if (short && /^(skip|skip (it|this|this one|question)|next|next question|pass)$/.test(t)) {
        void submitAnswer("skip");
        return true;
      }
      if (short && PERSONA_CMD.test(t)) {
        const p = parsePersona(t);
        if (p) {
          void changePersona(p);
          return true;
        }
      }
      if (intent.intent === "control") {
        if (intent.args.action === "repeat") { repeat(); return true; }
        if (intent.args.action === "next") { void submitAnswer("skip"); return true; }
        if (intent.args.action === "done" || intent.args.action === "send") return true;
        return false;
      }
      if (intent.intent === "navigation" && short) return false;
      if (busyRef.current) return true;
      void submitAnswer(text);
      return true;
    },
  });

  if (done && view.scorecard) {
    return (
      <div className="space-y-4">
        <header>
          <p className="muted">Scorecard</p>
          <h1 className="h1">{view.title}</h1>
        </header>
        {feedback && <p className="card text-lg">{feedback}</p>}
        <ScorecardView sc={view.scorecard} onRestart={() => router.push("/viva")} />
      </div>
    );
  }

  const pct = Math.max(0, Math.min(100, (remaining / (view.durationMin * 60_000)) * 100));
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="muted truncate">{view.title}</p>
          <p className="text-sm">
            {personaLabel(view.persona)} · {LEVEL[view.level]} · {view.answered} answered
          </p>
        </div>
        <div className="text-right" aria-live="off">
          <p className={`text-2xl font-semibold tabular-nums ${remaining < 60_000 ? "text-red" : ""}`} aria-label={`Time left ${fmt(remaining)}`}>
            {fmt(remaining)}
          </p>
          <p className="muted">left</p>
        </div>
      </header>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
      </div>

      <section className="card space-y-3" aria-live="polite">
        {q ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="muted">{q.isFollowUp ? "Follow-up" : `Question ${q.number}`}</span>
              <span className={`text-sm tabular-nums ${view.persona === "fast" && qRemaining < 10_000 ? "text-red" : "text-muted"}`}>
                {view.persona === "fast" ? "⏱ " : ""}{fmt(qRemaining)}
              </span>
            </div>
            <p className={`text-2xl font-medium leading-snug sm:text-3xl`}>{q.text}</p>
          </>
        ) : (
          <p className="muted">Wrapping up…</p>
        )}
        {busy && (
          <p className="muted flex items-center gap-2">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden />
            Examiner is listening to your answer…
          </p>
        )}
      </section>

      {(feedback || lastAnswer) && (
        <section className="card space-y-2">
          {feedback && <p className="text-lg"><span aria-hidden className="mr-1">💬</span>{feedback}</p>}
          {lastAnswer && lastAnswer !== "skip" && <p className="muted line-clamp-3">You said: “{lastAnswer}”</p>}
        </section>
      )}

      {error && (
        <div className="card border-red text-red" role="alert">
          <p>{error}</p>
          <button className="btn-ghost mt-2" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button className="btn-ghost" onClick={repeat} disabled={!q}>Repeat</button>
        <button className="btn-ghost" onClick={() => void submitAnswer("skip")} disabled={busy || !q}>Skip</button>
        <button className="btn-ghost" onClick={() => void changeDifficulty("easier")} disabled={busy || view.level === 1}>Easier</button>
        <button className="btn-ghost" onClick={() => void changeDifficulty("harder")} disabled={busy || view.level === 3}>Harder</button>
        <label className="sr-only" htmlFor="persona">Examiner</label>
        <select id="persona" className="input w-auto" value={view.persona} disabled={busy} onChange={(e) => void changePersona(e.target.value as Persona)}>
          {PERSONAS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <button className="btn-primary ml-auto" onClick={() => void end()} disabled={busy}>End viva</button>
      </div>
      <p className="muted">Answer out loud. Speak naturally; it submits when you pause.</p>
    </div>
  );
}
