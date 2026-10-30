"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { MasteryBadge } from "@/components/ui/MasteryBadge";
import { useVoice, useVoiceScreen } from "@/lib/voice/context";
import type { IntentResult } from "@/lib/types";
import type { Budget, ExamEvePlan, PlanTopic } from "@/lib/exameve";

type Phase = "setup" | "running" | "last";
type Step = "loading" | "buddy" | "question" | "grading" | "feedback";
const BUDGETS: Budget[] = [5, 10, 20];
const CHECK_SEC = 45;
const ANSWER_GRACE_MS = 12000;
const MIN_TOPIC_SEC = 35;

const fmt = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const LINK_RE = /\[([^\]]+)\]\((\/[^)\s]+)\)/g;
const forSpeech = (t: string) => t.replace(LINK_RE, "").replace(/[*_#`]/g, "").replace(/\s+([.,;:!?])/g, "$1");

function RichText({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push(<Link key={m.index} href={m[2]} className="text-base text-accent underline">{m[1]}</Link>);
    last = m.index! + m[0].length;
  }
  out.push(text.slice(last).replace(/\*\*/g, ""));
  return <>{out}</>;
}

function parseBudget(t: string): Budget | null {
  const s = t.toLowerCase();
  if (/\b(20|twenty|bees)\b/.test(s)) return 20;
  if (/\b(10|ten|das)\b/.test(s)) return 10;
  if (/\b(5|five|paanch)\b/.test(s)) return 5;
  return null;
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

export function ExamEve({ subjects, initialSubjectId, initialBudget }: {
  subjects: { id: string; name: string }[];
  initialSubjectId: string | null;
  initialBudget: Budget;
}) {
  const voice = useVoice();
  const [phase, setPhase] = useState<Phase>("setup");
  const [budget, setBudget] = useState<Budget>(initialBudget);
  const [subjectId, setSubjectId] = useState<string | null>(initialSubjectId ?? (subjects.length === 1 ? subjects[0].id : null));
  const [plan, setPlan] = useState<ExamEvePlan | null>(null);
  const [planState, setPlanState] = useState<"loading" | "ready" | "error">("loading");
  const [planError, setPlanError] = useState("");
  const [flagBusy, setFlagBusy] = useState<string | null>(null);

  const [idx, setIdx] = useState(0);
  const [step, setStep] = useState<Step>("loading");
  const [buddyText, setBuddyText] = useState("");
  const [question, setQuestion] = useState<{ question: string; claimId: string | null } | null>(null);
  const [feedback, setFeedback] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [lines, setLines] = useState<string[] | null>(null);
  const [lastError, setLastError] = useState("");

  const token = useRef(0);
  const startAt = useRef(0);
  const buddyDeadline = useRef(0);
  const answerDeadline = useRef(0);
  const attemptId = useRef<string | null>(null);
  const covered = useRef<PlanTopic[]>([]);
  const stepRef = useRef<Step>("loading");
  const idxRef = useRef(0);
  const planRef = useRef<ExamEvePlan | null>(null);
  const finished = useRef(false);
  const [usedSec, setUsedSec] = useState(0);
  stepRef.current = step;
  idxRef.current = idx;
  const setStepBoth = (s: Step) => { stepRef.current = s; setStep(s); };
  planRef.current = plan;

  // State updates happen only in the promise callbacks, after the request settles.
  const fetchPlan = useCallback(
    (b: Budget, s: string | null): Promise<void> =>
      fetch("/api/exam-eve/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ budgetMin: b, subjectId: s }) })
        .then(async (res) => {
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || "Couldn't build the plan");
          return body as ExamEvePlan;
        })
        .then(
          (body) => {
            setPlan(body);
            setPlanState("ready");
          },
          (e: unknown) => {
            setPlanError(e instanceof Error ? e.message : "Couldn't build the plan");
            setPlanState("error");
          },
        ),
    [],
  );

  const loadPlan = useCallback((b: Budget, s: string | null) => {
    setPlanState("loading");
    return fetchPlan(b, s);
  }, [fetchPlan]);

  // Back in setup with a new budget/subject (or returning to setup): show loading in the same
  // render, then fetch in the effect below.
  const planKey = `${phase}|${budget}|${subjectId ?? ""}`;
  const [planKeySeen, setPlanKeySeen] = useState(planKey);
  if (planKey !== planKeySeen) {
    setPlanKeySeen(planKey);
    if (phase === "setup") setPlanState("loading");
  }

  useEffect(() => { if (phase === "setup") void fetchPlan(budget, subjectId); }, [budget, subjectId, phase, fetchPlan]);

  const toggleFlag = async (t: PlanTopic) => {
    setFlagBusy(t.topicId);
    try {
      const res = await fetch(`/api/topics/${t.topicId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ in_exam: !t.inExam }) });
      if (!res.ok) throw new Error();
      await loadPlan(budget, subjectId);
    } catch {
      setPlanError("Couldn't update that topic.");
    } finally {
      setFlagBusy(null);
    }
  };

  const finish = useCallback(async (reason: "done" | "time" | "user") => {
    if (finished.current) return;
    finished.current = true;
    token.current++;
    voice.stop();
    const p = planRef.current;
    const started = covered.current.length;
    const left = p ? p.topics.slice(started).map((t) => t.name) : [];
    const extra: string[] = [];
    if (left.length) extra.push(`${reason === "time" ? "Time's up, so I skipped" : "Skipped"}: ${left.join(", ")}.`);
    if (p?.skipped.length) extra.push(`Didn't fit in ${p.budgetMin} minutes: ${p.skipped.map((s) => s.name).join(", ")}.`);
    setNotes((n) => [...n, ...extra]);
    setPhase("last");
    setLines(null);
    setLastError("");
    const used = (Date.now() - startAt.current) / 1000;
    setUsedSec(used);
    try {
      const res = await fetch("/api/exam-eve/last-look", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ topics: covered.current.map((t) => ({ topicId: t.topicId, claimIds: t.gapClaims.map((c) => c.id) })), budgetMin: p?.budgetMin, elapsedSec: Math.round(used) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Couldn't build the last look");
      setLines(body.lines);
      if (body.lines.length) voice.speak(`Last look. ${body.lines.map(forSpeech).join(". ")}`);
    } catch (e) {
      setLastError(e instanceof Error ? e.message : "Couldn't build the last look");
      setLines(covered.current.flatMap((t) => t.gapClaims.slice(0, 1).map((c) => `${t.name}: ${c.text}`)).slice(0, 5));
    }
  }, [voice]);

  const askQuestion = useCallback(async (prev: number) => {
    if (token.current !== prev || stepRef.current === "question") return;
    const my = ++token.current;
    const p = planRef.current!;
    const t = p.topics[idxRef.current];
    setStepBoth("question");
    voice.stop();
    setQuestion(null);
    answerDeadline.current = Date.now() + CHECK_SEC * 1000 + ANSWER_GRACE_MS;
    try {
      const res = await fetch("/api/exam-eve/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topicId: t.topicId, claimIds: t.gapClaims.map((c) => c.id) }) });
      const body = await res.json();
      if (token.current !== my) return;
      const q = res.ok ? body : { question: `In one line, what's the key idea of ${t.name}?`, claimId: t.gapClaims[0]?.id ?? null };
      setQuestion(q);
      voice.speak(`Quick check. ${q.question}`);
    } catch {
      if (token.current !== my) return;
      const q = { question: `In one line, what's the key idea of ${t.name}?`, claimId: t.gapClaims[0]?.id ?? null };
      setQuestion(q);
      voice.speak(`Quick check. ${q.question}`);
    }
  }, [voice]);

  const startTopic = useCallback(async (i: number) => {
    const my = ++token.current;
    const p = planRef.current;
    if (!p || i >= p.topics.length) { void finish("done"); return; }
    const remainingSec = p.budgetMin * 60 - (Date.now() - startAt.current) / 1000;
    const restAlloc = p.topics.slice(i).reduce((a, t) => a + t.allocSec, 0);
    const allowed = remainingSec * (p.topics[i].allocSec / Math.max(1, restAlloc));
    if (allowed < MIN_TOPIC_SEC || remainingSec < MIN_TOPIC_SEC) { void finish("time"); return; }
    const t = p.topics[i];
    covered.current = [...covered.current.slice(0, i), t];
    setIdx(i); idxRef.current = i;
    setStepBoth("loading"); setBuddyText(""); setQuestion(null); setFeedback("");
    buddyDeadline.current = Date.now() + Math.max(20, allowed - CHECK_SEC) * 1000;
    answerDeadline.current = Number.POSITIVE_INFINITY;
    try {
      const a = await fetch("/api/exam-eve/attempt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topicId: t.topicId, claimIds: t.gapClaims.map((c) => c.id) }) });
      const ab = await a.json();
      if (!a.ok) throw new Error(ab.error);
      attemptId.current = ab.attemptId;
      if (token.current !== my) return;
      const res = await fetch("/api/buddy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topicId: t.topicId, attemptId: ab.attemptId, mode: "exam_eve" }) });
      if (!res.ok || !res.body) throw new Error("buddy");
      setStepBoth("buddy");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (token.current !== my) { void reader.cancel(); return; }
        if (done) break;
        text += dec.decode(value, { stream: true });
        setBuddyText(text);
      }
      voice.speak(forSpeech(text), { onEnd: () => { if (token.current === my && stepRef.current === "buddy") void askQuestion(my); } });
    } catch {
      if (token.current !== my) return;
      const text = `Here's what to remember for ${t.name}. ${t.gapClaims.map((c) => c.text).join(" ")}`;
      setStepBoth("buddy");
      setBuddyText(text);
      voice.speak(text, { onEnd: () => { if (token.current === my && stepRef.current === "buddy") void askQuestion(my); } });
    }
  }, [voice, finish, askQuestion]);

  const submitAnswer = useCallback(async (text: string) => {
    const p = planRef.current;
    if (!p || !text.trim() || stepRef.current !== "question") return;
    const my = token.current;
    const t = p.topics[idxRef.current];
    voice.stop();
    setStepBoth("grading");
    let fb = "Thanks. Moving on.";
    try {
      const res = await fetch("/api/exam-eve/check", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ topicId: t.topicId, claimIds: t.gapClaims.map((c) => c.id), claimId: question?.claimId, answer: text, attemptId: attemptId.current }),
      });
      const body = await res.json();
      if (res.ok) fb = body.feedback;
    } catch { /* keep default feedback */ }
    if (token.current !== my) return;
    setFeedback(fb);
    setStepBoth("feedback");
    const go = () => { if (token.current === my) void startTopic(idxRef.current + 1); };
    voice.speak(fb, { onEnd: () => window.setTimeout(go, 600) });
    window.setTimeout(go, 9000);
  }, [voice, question, startTopic]);

  const skipTopic = useCallback(() => {
    const p = planRef.current;
    if (!p) return;
    setNotes((n) => [...n, `You skipped ${p.topics[idxRef.current].name}.`]);
    void startTopic(idxRef.current + 1);
  }, [startTopic]);

  const start = () => {
    if (!plan?.topics.length) return;
    covered.current = [];
    finished.current = false;
    setNotes([]);
    startAt.current = Date.now();
    setElapsed(0);
    setPhase("running");
    void startTopic(0);
  };

  // timer + budget enforcement
  useEffect(() => {
    if (phase !== "running") return;
    const iv = window.setInterval(() => {
      const p = planRef.current;
      if (!p) return;
      const el = (Date.now() - startAt.current) / 1000;
      setElapsed(el);
      if (el >= p.budgetMin * 60) { void finish("time"); return; }
      const nowMs = Date.now();
      if (stepRef.current === "buddy" && nowMs > buddyDeadline.current) void askQuestion(token.current);
      else if (stepRef.current === "question" && nowMs > answerDeadline.current) {
        setNotes((n) => [...n, `No answer in time for ${p.topics[idxRef.current].name}.`]);
        void startTopic(idxRef.current + 1);
      }
    }, 500);
    return () => window.clearInterval(iv);
  }, [phase, finish, askQuestion, startTopic]);

  useEffect(() => () => { token.current++; }, []);

  const current = plan?.topics[idx];
  const totalSec = (plan?.budgetMin ?? budget) * 60;

  useVoiceScreen({
    hint:
      phase === "setup" ? `Say "5 minutes", "10" or "20 minutes", then "start"`
        : phase === "running"
          ? step === "question" ? `Answer the question, or say "skip"` : `Say "next", "skip" or "done"`
          : `Say "again" to restart or "home"`,
    mode: phase === "running" && step === "question" ? "explain" : "exam_eve",
    subjectId: subjectId ?? undefined,
    topicId: phase === "running" ? current?.topicId : undefined,
    onInput: (text: string, intent: IntentResult) => {
      const t = norm(text);
      const action = intent.intent === "control" ? String(intent.args.action ?? "") : "";
      if (phase === "setup") {
        const b = parseBudget(t);
        if (b) { setBudget(b); voice.speak(`${b} minutes. Say start when ready.`); if (!/\b(start|go|begin)\b/.test(t)) return true; }
        if (/\b(start|go|begin|chalo|let s go)\b/.test(t) || action === "next") {
          if (plan?.topics.length) start(); else voice.speak("There's nothing red or amber to revise right now.");
          return true;
        }
        const sub = subjects.find((s) => t.includes(norm(s.name)));
        if (sub) { setSubjectId(sub.id); return true; }
        if (/\ball subjects\b/.test(t)) { setSubjectId(null); return true; }
        const flagged = plan?.topics.find((p) => t.includes(norm(p.name)));
        if (flagged && /(flag|in the exam|will be in|exam me)/.test(t)) { void toggleFlag(flagged); return true; }
        return !!b;
      }
      if (phase === "running") {
        if (/^(done|finish|end|that s it|stop exam)/.test(t) || action === "done") { void finish("user"); return true; }
        if (/^skip/.test(t)) { skipTopic(); return true; }
        if (/^next/.test(t) || action === "next") {
          if (stepRef.current === "buddy" || stepRef.current === "loading") void askQuestion(token.current);
          else if (stepRef.current === "feedback") void startTopic(idxRef.current + 1);
          else skipTopic();
          return true;
        }
        if (stepRef.current === "question" && (intent.intent === "explanation" || intent.intent === "unclear" || intent.intent === "interrupt")) {
          void submitAnswer(text);
          return true;
        }
        return false;
      }
      if (/\b(again|restart|one more)\b/.test(t)) { setPhase("setup"); return true; }
      return false;
    },
  });

  if (phase === "setup") {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <div>
          <h1 className="h1">Exam-eve mode</h1>
          <p className="muted">A short crash revision of only your weak spots, in the order that matters most.</p>
        </div>

        <div className="card space-y-3">
          <p className="h2">How much time do you have?</p>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Time budget">
            {BUDGETS.map((b) => (
              <button key={b} role="radio" aria-checked={budget === b} onClick={() => setBudget(b)}
                className={`btn py-4 text-lg ${budget === b ? "bg-accent text-accent-fg" : "border border-line bg-surface hover:bg-surface-2"}`}>
                {b} min
              </button>
            ))}
          </div>
          {subjects.length > 1 && (
            <div>
              <label htmlFor="ee-subject" className="muted">Subject</label>
              <select id="ee-subject" className="input mt-1" value={subjectId ?? ""} onChange={(e) => setSubjectId(e.target.value || null)}>
                <option value="">All subjects</option>
                {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
        </div>

        {planState === "loading" && (
          <div className="card space-y-2" aria-busy="true">
            <div className="h-5 w-40 animate-pulse rounded bg-surface-2" />
            <div className="h-12 animate-pulse rounded-xl bg-surface-2" />
            <div className="h-12 animate-pulse rounded-xl bg-surface-2" />
          </div>
        )}
        {planState === "error" && (
          <div className="card flex items-center justify-between gap-3">
            <p className="text-sm">{planError}</p>
            <button className="btn-ghost" onClick={() => loadPlan(budget, subjectId)}>Retry</button>
          </div>
        )}
        {planState === "ready" && plan && (plan.topics.length === 0 ? (
          <div className="card space-y-3 text-center">
            <MasteryBadge mastery="green" />
            <p>Nothing red or amber here. You&apos;re in good shape.</p>
            <p className="muted">Explain a few more topics, or check what&apos;s due for review.</p>
            <div className="flex justify-center gap-2">
              <Link href="/review" className="btn-ghost">Review</Link>
              <Link href="/home" className="btn-primary">Heatmap</Link>
            </div>
          </div>
        ) : (
          <div className="card space-y-3">
            <div className="flex items-baseline justify-between">
              <p className="h2">The plan</p>
              <span className="muted">{plan.topics.length} topic{plan.topics.length > 1 ? "s" : ""} · about {fmt(plan.totalSec)}</span>
            </div>
            <ol className="space-y-2">
              {plan.topics.map((t, i) => (
                <li key={t.topicId} className="rounded-xl border border-line p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">{i + 1}. {t.name}</p>
                      <p className="muted">{t.gapClaims.length} gap{t.gapClaims.length > 1 ? "s" : ""} · {t.reason}{subjects.length > 1 && !subjectId ? ` · ${t.subjectName}` : ""}</p>
                    </div>
                    {t.mastery !== "ungraded" ? <MasteryBadge mastery={t.mastery} /> : <MasteryBadge mastery="red" />}
                  </div>
                  <button className={`mt-2 text-sm underline-offset-2 hover:underline ${t.inExam ? "font-medium text-accent" : "text-muted"}`}
                    disabled={flagBusy === t.topicId} onClick={() => toggleFlag(t)} aria-pressed={t.inExam}>
                    {t.inExam ? "★ Will be in the exam (tap to unflag)" : "☆ Flag: will be in the exam"}
                  </button>
                </li>
              ))}
            </ol>
            {plan.skipped.length > 0 && (
              <p className="muted">Won&apos;t fit in {plan.budgetMin} minutes: {plan.skipped.map((s) => s.name).join(", ")}.</p>
            )}
            <button className="btn-primary w-full py-3 text-base" onClick={start}>Start {plan.budgetMin}-minute crash revision</button>
          </div>
        ))}
      </div>
    );
  }

  if (phase === "running" && plan && current) {
    const remaining = totalSec - elapsed;
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="sticky top-14 z-20 -mx-4 border-b border-line bg-bg/90 px-4 py-2 backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted">Topic {idx + 1} of {plan.topics.length}</span>
            <span className={`font-mono text-2xl tabular-nums ${remaining < 60 ? "text-red" : ""}`} aria-label={`${fmt(remaining)} remaining`}>{fmt(remaining)}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full bg-accent transition-all" style={{ width: `${Math.min(100, (elapsed / totalSec) * 100)}%` }} />
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <h1 className="h1">{current.name}</h1>
          {current.mastery !== "ungraded" && <MasteryBadge mastery={current.mastery} />}
        </div>

        <div className="card">
          {step === "loading" ? (
            <p className="muted" aria-busy="true">Picking out just your gaps…</p>
          ) : (
            <p className="buddy-text whitespace-pre-wrap"><RichText text={buddyText} /></p>
          )}
        </div>

        {(step === "question" || step === "grading" || step === "feedback") && (
          <div className="card space-y-3 border-2 border-accent">
            <p className="text-lg font-medium">{question ? question.question : "Getting a quick question…"}</p>
            {step === "question" && question && (
              <p className="muted">Answer out loud. Samjha checks it when you pause.</p>
            )}
            {step === "grading" && <p className="muted">Checking…</p>}
            {step === "feedback" && <p className="text-lg">{feedback}</p>}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {step === "buddy" && <button className="btn-primary" onClick={() => askQuestion(token.current)}>Next: quick check</button>}
          {step === "feedback" && <button className="btn-primary" onClick={() => startTopic(idx + 1)}>Next topic</button>}
          <button className="btn-ghost" onClick={skipTopic}>Skip topic</button>
          <button className="btn-ghost" onClick={() => finish("user")}>Done</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="h1">Last look</h1>
        <span className="muted">{fmt(usedSec)} of {plan?.budgetMin ?? budget} min</span>
      </div>
      {lines === null ? (
        <div className="space-y-3" aria-busy="true">
          {[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-8 animate-pulse rounded-lg bg-surface-2" />)}
        </div>
      ) : lines.length === 0 ? (
        <div className="card text-center"><p>You ended before any topic. Nothing to recap yet.</p></div>
      ) : (
        <ol className="card space-y-4">
          {lines.map((l, i) => (
            <li key={i} className="flex gap-3 text-xl font-medium leading-snug sm:text-2xl">
              <span className="text-accent">{i + 1}</span><span>{l}</span>
            </li>
          ))}
        </ol>
      )}
      {lastError && <p className="muted">{lastError}. Showing your notes instead.</p>}
      {notes.length > 0 && <ul className="muted space-y-1">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      <div className="flex flex-wrap gap-2">
        <button className="btn-primary" onClick={() => setPhase("setup")}>Run again</button>
        <Link className="btn-ghost" href="/home">Heatmap</Link>
        {covered.current[0] && <Link className="btn-ghost" href={`/graph/${covered.current[0].subjectId}`}>Concept graph</Link>}
      </div>
    </div>
  );
}
