"use client";
// Session state machine: explain → grading → result → buddy → explain_back → grading → result → (buddy again | summary).
// One useVoiceScreen registration owns every spoken command so the whole loop works voice-only.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVoice, useVoiceScreen } from "@/lib/voice/context";
import { MasteryBadge } from "@/components/ui/MasteryBadge";
import type { AttemptKind, ClaimGrade, IntentResult, Mastery, PrefKey, Prefs } from "@/lib/types";
import type { AttemptRecord, BuddyMode, GradeResponse, Phase, SessionClaim, SessionTopic } from "./types";
import { RX, friendlyError, wordCount } from "./text";
import { useBuddyStream } from "./useBuddyStream";
import { ExplainPanel } from "./ExplainPanel";
import { GradingPanel } from "./GradingPanel";
import { ResultView } from "./ResultView";
import { BuddyPanel } from "./BuddyPanel";
import { SummaryCard, type NextTopic } from "./SummaryCard";

export interface SessionFlowProps {
  topic: SessionTopic;
  claims: SessionClaim[];
  kind: "explain" | "review";
  onlyClaimIds: string[] | null;
  isDemo: boolean;
  returnTo: { id: string; name: string } | null;
  primarySourceId: string | null;
}

type Offer =
  | { kind: "root"; root: { id: string; name: string; mastery?: Mastery } }
  | { kind: "continue" }
  | { kind: "keep_shorter"; text: string }
  | { kind: "buddy_again" };

const MODE_LABEL: Partial<Record<BuddyMode, string>> = {
  gaps: "Your gaps",
  why: "Why?",
  example: "Example",
  shorter: "Shorter",
  stuck: "Different angle",
  question: "Your question",
  restyle: "Restyled",
};

const STEPS: { key: Phase[]; label: string }[] = [
  { key: ["explain"], label: "Explain" },
  { key: ["grading", "result"], label: "Check" },
  { key: ["buddy"], label: "Fix" },
  { key: ["explain_back"], label: "Explain back" },
  { key: ["summary"], label: "Done" },
];

const gapsOf = (a: AttemptRecord | undefined) => (a ? a.result.claims.filter((c) => c.status !== "covered") : []);

function extractGrade(j: unknown, claimId: string): ClaimGrade | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const isGrade = (x: unknown): x is ClaimGrade => !!x && typeof x === "object" && "status" in x && (x as ClaimGrade).claim_id === claimId;
  for (const k of ["grade", "claim", "claimGrade"]) if (isGrade(o[k])) return o[k] as ClaimGrade;
  const lists = [(o.result as { claims?: unknown[] } | undefined)?.claims, o.claims as unknown[] | undefined];
  for (const l of lists) if (Array.isArray(l)) { const f = l.find(isGrade); if (f) return f as ClaimGrade; }
  return isGrade(o) ? (o as unknown as ClaimGrade) : null;
}

export function SessionFlow({ topic, claims, kind, onlyClaimIds, isDemo, returnTo, primarySourceId }: SessionFlowProps) {
  const router = useRouter();
  const voice = useVoice();
  const voiceRef = useRef(voice);
  useLayoutEffect(() => {
    voiceRef.current = voice;
  }, [voice]);

  const [phase, setPhaseState] = useState<Phase>("explain");
  const phaseRef = useRef<Phase>("explain");
  const setPhase = useCallback((p: Phase) => { phaseRef.current = p; setPhaseState(p); }, []);

  const [attempts, setAttemptsState] = useState<AttemptRecord[]>([]);
  const attemptsRef = useRef<AttemptRecord[]>([]);
  const setAttempts = useCallback((a: AttemptRecord[]) => { attemptsRef.current = a; setAttemptsState(a); }, []);

  const [pending, setPending] = useState<{ text: string; kind: AttemptKind } | null>(null);
  const [gradeError, setGradeError] = useState<string | null>(null);
  const [offer, setOfferState] = useState<Offer | null>(null);
  const offerRef = useRef<Offer | null>(null);
  const setOffer = useCallback((o: Offer | null) => { offerRef.current = o; setOfferState(o); }, []);
  const [note, setNote] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ startedAt: number; endedAt: number; streak: number | null; next: NextTopic | null } | null>(null);
  const [promptKey, setPromptKey] = useState(0);

  const [mountedAt] = useState(() => Date.now());
  const startedAt = useRef(mountedAt);
  const buddyRounds = useRef(0);
  const stuckCount = useRef(0);
  const autoToken = useRef(0);

  const shownClaims = useMemo(() => (onlyClaimIds ? claims.filter((c) => onlyClaimIds.includes(c.id)) : claims), [claims, onlyClaimIds]);
  const last = attempts.at(-1);
  const prevForLast = last?.kind === "explain_back" ? attempts.at(-2) : undefined;
  const gapsLeft = gapsOf(last).length;

  const buddy = useBuddyStream((text, suggestion) => {
    if (suggestion) {
      setNote(suggestion);
      setOffer({ kind: "keep_shorter", text: suggestion });
    } else if (/want me to go on\?/i.test(text.slice(-200))) setOffer({ kind: "continue" });
  });

  const speak = useCallback((t: string, onEnd?: () => void) => voiceRef.current.speak(t, onEnd ? { onEnd } : undefined), []);

  // Spoken prompt whenever we enter an explain state.
  useEffect(() => {
    if (phase === "explain") {
      speak(
        kind === "review" && onlyClaimIds
          ? `Quick review. Explain ${topic.name} like you're teaching a junior. Take your time.`
          : `Explain ${topic.name} like you're teaching a junior. Take your time.`,
      );
    } else if (phase === "explain_back") {
      speak(`Now explain ${topic.name} back to me. The whole thing, in your own words.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, promptKey]);

  // ---------- actions ----------

  const restream = useCallback(
    (mode: BuddyMode, extra: { question?: string; oncePrefs?: Partial<Prefs>; differentAnalogy?: boolean; preface?: string } = {}) => {
      const a = attemptsRef.current.at(-1);
      if (!a) return;
      setOffer(null);
      if (phaseRef.current !== "buddy") setPhase("buddy");
      void buddy.start({ topicId: topic.id, attemptId: a.attemptId, mode, append: mode === "continue", label: MODE_LABEL[mode], ...extra });
    },
    [buddy, setOffer, setPhase, topic.id],
  );

  const startBuddy = useCallback(
    (differentAnalogy: boolean) => {
      buddyRounds.current += 1;
      setNote(null);
      restream("gaps", { differentAnalogy });
    },
    [restream],
  );

  const runTrace = useCallback(async (): Promise<boolean> => {
    setNote("Looking for the real gap…");
    try {
      const res = await fetch(`/api/graph/trace?topicId=${encodeURIComponent(topic.id)}`);
      const j = (await res.json().catch(() => null)) as { root?: { id: string; name: string; mastery?: Mastery } | null } | null;
      if (res.ok && j?.root && j.root.id !== topic.id) {
        buddy.stop();
        setNote(null);
        setOffer({ kind: "root", root: j.root });
        speak(`Want to fix ${j.root.name} first? It'll take about 3 minutes.`);
        return true;
      }
    } catch {
      /* trace is optional */
    }
    setNote(null);
    return false;
  }, [buddy, setOffer, speak, topic.id]);

  const onStuck = useCallback(async () => {
    stuckCount.current += 1;
    if (stuckCount.current >= 2 && (await runTrace())) return;
    restream("stuck", { differentAnalogy: true, preface: "Okay, let me try a different angle." });
  }, [restream, runTrace]);

  const announceResult = useCallback(
    (rec: AttemptRecord, prev: AttemptRecord | undefined) => {
      const graded = rec.result.claims;
      const covered = graded.filter((c) => c.status === "covered").length;
      const gaps = graded.length - covered;
      if (prev) {
        const before = new Map(prev.result.claims.map((c) => [c.claim_id, c.status]));
        const flipped = graded.filter((c) => c.status === "covered" && before.get(c.claim_id) !== "covered").length;
        if (!gaps) {
          speak(`Yes! All ${graded.length} ideas covered.${flipped ? ` ${flipped} turned green.` : ""} Say next for your summary.`);
          return;
        }
        const greens = Object.values(rec.mastery).filter((m) => m === "green").length;
        const share = Object.keys(rec.mastery).length ? greens / Object.keys(rec.mastery).length : covered / Math.max(1, graded.length);
        if (buddyRounds.current >= 2 && share < 0.4) {
          void runTrace().then((found) => {
            if (!found) {
              setOffer({ kind: "buddy_again" });
              speak(`${gaps} still need work. Want another go with a different angle?`);
            }
          });
          return;
        }
        setOffer({ kind: "buddy_again" });
        speak(`${flipped ? `${flipped} more turned green. ` : ""}${gaps} still need work. Want another go with a different angle?`);
        return;
      }
      if (!gaps) {
        speak(`You covered all ${graded.length} ideas. Say next for your summary.`);
        return;
      }
      const tok = ++autoToken.current;
      speak(`You covered ${covered} of ${graded.length} ideas. Let's fix the rest.`, () => {
        if (autoToken.current === tok && phaseRef.current === "result") startBuddy(false);
      });
    },
    [runTrace, setOffer, speak, startBuddy],
  );

  const grade = useCallback(
    async (explanation: string, k?: AttemptKind) => {
      const gk: AttemptKind = k ?? (phaseRef.current === "explain_back" ? "explain_back" : kind);
      buddy.stop();
      setOffer(null);
      setNote(null);
      setPending({ text: explanation, kind: gk });
      setGradeError(null);
      setPhase("grading");
      const prev = attemptsRef.current.at(-1);
      try {
        const res = await fetch("/api/grade", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            topicId: topic.id,
            explanation,
            kind: gk,
            onlyClaimIds: onlyClaimIds ?? undefined,
            parentAttemptId: gk === "explain_back" ? prev?.attemptId : undefined,
            afterBuddy: gk === "explain_back" && buddyRounds.current > 0,
          }),
        });
        const j = (await res.json().catch(() => null)) as (GradeResponse & { error?: string }) | null;
        if (!res.ok || !j?.result || !j.attemptId) throw Object.assign(new Error(friendlyError(res.status)), { friendly: true });
        const rec: AttemptRecord = { attemptId: j.attemptId, kind: gk, explanation, result: { ...j.result, misconceptions: j.result.misconceptions ?? [], strengths: j.result.strengths ?? [] }, mastery: j.mastery ?? {} };
        setAttempts([...attemptsRef.current, rec]);
        setPending(null);
        setPhase("result");
        announceResult(rec, gk === "explain_back" ? prev : undefined);
      } catch (e) {
        const msg = e instanceof Error && (e as Error & { friendly?: boolean }).friendly ? e.message : "Couldn't reach Samjha. Check your connection and say \"try again\".";
        setGradeError(msg);
        speak("Sorry, I couldn't check that one. Say try again.");
      }
    },
    [announceResult, buddy, kind, onlyClaimIds, setAttempts, setOffer, setPhase, speak, topic.id],
  );

  const appeal = useCallback(
    async (attemptId: string, claimId: string, noteText: string) => {
      const res = await fetch("/api/grade/appeal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attemptId, claimId, note: noteText }),
      });
      const j = (await res.json().catch(() => null)) as ({ error?: string; mastery?: Record<string, Mastery> } & Record<string, unknown>) | null;
      if (!res.ok) throw new Error(friendlyError(res.status));
      const g = extractGrade(j, claimId);
      setAttempts(
        attemptsRef.current.map((a) =>
          a.attemptId !== attemptId
            ? a
            : {
                ...a,
                result: g ? { ...a.result, claims: a.result.claims.map((c) => (c.claim_id === claimId ? { ...c, ...g } : c)) } : a.result,
                mastery: j?.mastery && typeof j.mastery === "object" ? { ...a.mastery, ...j.mastery } : a.mastery,
              },
        ),
      );
      if (g) speak(g.status === "covered" ? "You're right, I've marked that one covered." : "I re-checked it, and your notes still disagree. Have a look at the correction.");
    },
    [setAttempts, speak],
  );

  const goExplainBack = useCallback(() => {
    autoToken.current++;
    buddy.stop();
    setOffer(null);
    setNote(null);
    setPhase("explain_back");
  }, [buddy, setOffer, setPhase]);

  const toSummary = useCallback(async () => {
    buddy.stop();
    setOffer(null);
    setNote(null);
    const endedAt = Date.now();
    const started = startedAt.current;
    setSummary({ startedAt: started, endedAt, streak: null, next: null });
    setPhase("summary");
    const [streak, next] = await Promise.all([
      fetch("/api/study/streak")
        .then((r) => (r.ok ? r.json() : null))
        .then((j: unknown) => (typeof j === "number" ? j : j && typeof j === "object" ? Number((j as { streak?: number; days?: number }).streak ?? (j as { days?: number }).days) : NaN))
        .catch(() => NaN),
      fetch("/api/study/next")
        .then((r) => (r.ok ? r.json() : null))
        .then((j: NextTopic | null) => (j?.topicId && j.topicId !== topic.id ? j : null))
        .catch(() => null),
    ]);
    const s = Number.isFinite(streak) ? (streak as number) : null;
    setSummary({ startedAt: started, endedAt, streak: s, next });
    const a = attemptsRef.current;
    const first = a[0];
    const lastA = a.at(-1);
    const before = new Map(first?.result.claims.map((c) => [c.claim_id, c.status]) ?? []);
    const fixed = a.length > 1 ? (lastA?.result.claims.filter((c) => c.status === "covered" && before.get(c.claim_id) !== "covered").length ?? 0) : 0;
    const mins = Math.max(1, Math.round((endedAt - startedAt.current) / 60000));
    let line = `Session done. ${fixed ? `You fixed ${fixed} idea${fixed === 1 ? "" : "s"}` : "Nice work"} in about ${mins} minute${mins === 1 ? "" : "s"}.`;
    if (s) line += ` Your streak is ${s} day${s === 1 ? "" : "s"}.`;
    if (returnTo) line += ` Want to go back to ${returnTo.name}? Say go back.`;
    else if (next) line += ` Say next for ${next.name}.`;
    speak(line);
  }, [buddy, returnTo, setOffer, setPhase, speak, topic.id]);

  const goNext = useCallback(async () => {
    let next = summary?.next ?? null;
    if (!next) {
      next = await fetch("/api/study/next")
        .then((r) => (r.ok ? r.json() : null))
        .then((j: NextTopic | null) => (j?.topicId && j.topicId !== topic.id ? j : null))
        .catch(() => null);
    }
    router.push(next ? `/session/${next.topicId}` : "/home");
  }, [router, summary, topic.id]);

  const startAgain = useCallback(() => {
    buddy.stop();
    setAttempts([]);
    setOffer(null);
    setNote(null);
    setPending(null);
    setGradeError(null);
    setSummary(null);
    buddyRounds.current = 0;
    stuckCount.current = 0;
    startedAt.current = Date.now();
    setPhase("explain");
    setPromptKey((k) => k + 1);
  }, [buddy, setAttempts, setOffer, setPhase]);

  const suggest = useCallback(async () => {
    setSuggesting(true);
    setSuggestError(null);
    try {
      const res = await fetch(`/api/demo/suggestion?topicId=${encodeURIComponent(topic.id)}`);
      const j = (await res.json().catch(() => null)) as { text?: string; error?: string } | null;
      if (!res.ok || !j?.text) throw new Error("There's no sample explanation for this topic. Try explaining it in your own words.");
      voiceRef.current.setInput(j.text, true);
    } catch (e) {
      setSuggestError(e instanceof Error && /sample/.test(e.message) ? e.message : "Couldn't load the sample explanation. Try again in a moment.");
    } finally {
      setSuggesting(false);
    }
  }, [topic.id]);

  const applyStyle = useCallback(
    async (text: string, intent: IntentResult, rerun: boolean) => {
      buddy.stop();
      let confirmation = "";
      let applied = false;
      let serverOnce: Partial<Prefs> | undefined;
      try {
        const res = await fetch("/api/prefs/command", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, subjectId: topic.subjectId }),
        });
        const j = (await res.json().catch(() => null)) as { applied?: unknown; confirmation?: string; oncePrefs?: Partial<Prefs> } | null;
        applied = res.ok && !!j?.applied;
        confirmation = j?.confirmation || "";
        if (res.ok && j?.oncePrefs && typeof j.oncePrefs === "object") serverOnce = j.oncePrefs;
      } catch {
        /* fall back to a one-off restyle below */
      }
      const args = intent.args;
      let oncePrefs: Partial<Prefs> | undefined = serverOnce;
      if (!oncePrefs && intent.intent === "scope" && typeof args.scope === "string") oncePrefs = { scope: args.scope };
      else if (!oncePrefs && typeof args.key === "string" && typeof args.value === "string" && (args.persist === "once" || !applied))
        oncePrefs = { [args.key as PrefKey]: args.value } as Partial<Prefs>;
      confirmation ||= args.persist === "once" ? "Okay, just this time." : intent.intent === "scope" ? "Okay, changing what I cover." : "Got it.";
      setNote(confirmation);
      if (rerun && attemptsRef.current.length) restream("restyle", { oncePrefs, preface: confirmation });
      else speak(confirmation);
    },
    [buddy, restream, speak, topic.subjectId],
  );

  const acceptOffer = useCallback(
    (o: Offer) => {
      setOffer(null);
      if (o.kind === "root") {
        buddy.stop();
        router.push(`/session/${o.root.id}?returnTo=${encodeURIComponent(topic.id)}`);
      } else if (o.kind === "continue") restream("continue");
      else if (o.kind === "keep_shorter") {
        setNote("Got it, shorter from now on.");
        speak("Got it, shorter from now on.");
        void fetch("/api/prefs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: "length", value: "very short" }),
        }).catch(() => {});
      } else startBuddy(true);
    },
    [buddy, restream, router, setOffer, startBuddy, topic.id],
  );

  const declineOffer = useCallback(
    (o: Offer) => {
      setOffer(null);
      if (o.kind === "root") restream("stuck", { differentAnalogy: true, preface: "No problem. Let me try a different angle." });
      else if (o.kind === "continue") speak("Okay. Say explain it back when you're ready.");
      else if (o.kind === "keep_shorter") { setNote(null); speak("No problem, I'll keep your usual length."); }
      else void toSummary();
    },
    [restream, setOffer, speak, toSummary],
  );

  // ---------- voice ----------

  const onInput = async (raw: string, intent: IntentResult): Promise<boolean> => {
    const text = raw.trim();
    if (!text) return true;
    autoToken.current++;
    const ph = phaseRef.current;
    const ctrl = intent.intent === "control" ? String(intent.args.action ?? "") : "";
    if (ctrl === "stop" || ctrl === "pause") {
      buddy.silence();
      return false;
    }
    const long = wordCount(text) >= 12;
    const isExplanation = intent.intent === "explanation" || long;

    const o = offerRef.current;
    if (o && !long) {
      if (RX.yes.test(text) || (o.kind === "continue" && RX.goOn.test(text))) { acceptOffer(o); return true; }
      if (RX.no.test(text)) { declineOffer(o); return true; }
    }
    if (!long && RX.startAgain.test(text)) { startAgain(); return true; }

    if (ph === "explain" || ph === "explain_back") {
      if (isDemo && ph === "explain" && !long && RX.suggest.test(text)) { void suggest(); return true; }
      if (isExplanation) { void grade(text); return true; }
      if (intent.intent === "style" || intent.intent === "scope") { void applyStyle(text, intent, false); return true; }
      if (ph === "explain_back" && RX.summary.test(text)) { void toSummary(); return true; }
      if (RX.done.test(text) || ctrl === "done" || ctrl === "send") {
        speak("I didn't catch an explanation yet. Go ahead, take your time.");
        return true;
      }
      return false;
    }

    if (ph === "grading") {
      if (gradeError && pending && (RX.retry.test(text) || RX.yes.test(text))) { void grade(pending.text, pending.kind); return true; }
      if (gradeError && isExplanation) { void grade(text, pending?.kind); return true; }
      return false;
    }

    if (ph === "result") {
      const lastA = attemptsRef.current.at(-1);
      if (!lastA) return false;
      const ap = text.match(RX.appeal);
      if (ap) {
        const c = shownClaims[Number(ap[2]) - 1];
        if (c) {
          appeal(lastA.attemptId, c.id, text).catch(() => speak("I couldn't re-check that right now."));
          return true;
        }
      }
      if (RX.explainBack.test(text)) { goExplainBack(); return true; }
      if (long && intent.intent === "explanation") { setPhase("explain_back"); void grade(text, "explain_back"); return true; }
      const gaps = gapsOf(lastA).length;
      if (!gaps) {
        if (RX.yes.test(text) || RX.next.test(text) || RX.done.test(text) || RX.summary.test(text) || ctrl === "next" || ctrl === "done") {
          void toSummary();
          return true;
        }
        return false;
      }
      if (RX.yes.test(text) || RX.fix.test(text) || RX.next.test(text) || ctrl === "next") { startBuddy(lastA.kind === "explain_back"); return true; }
      if (RX.summary.test(text) || RX.no.test(text) || RX.done.test(text) || ctrl === "done") { void toSummary(); return true; }
      if (intent.intent === "style" || intent.intent === "scope") { void applyStyle(text, intent, true); return true; }
      if (intent.intent === "interrupt" || /\?\s*$/.test(text)) {
        startBuddy(false);
        return true;
      }
      return false;
    }

    if (ph === "buddy") {
      if (RX.explainBack.test(text) || (!long && (RX.done.test(text) || RX.next.test(text) || ctrl === "next" || ctrl === "done"))) {
        goExplainBack();
        return true;
      }
      const ik = intent.intent === "interrupt" ? String(intent.args.kind ?? "") : "";
      if (ik === "stuck" || (!long && RX.stuck.test(text))) { void onStuck(); return true; }
      if (ik === "why" || ik === "example" || ik === "shorter" || ik === "question") {
        restream(ik, { question: text });
        return true;
      }
      if (intent.intent === "style" || intent.intent === "scope") { void applyStyle(text, intent, true); return true; }
      if (!long) {
        if (RX.why.test(text)) { restream("why", { question: text }); return true; }
        if (RX.example.test(text)) { restream("example", { question: text }); return true; }
        if (RX.shorter.test(text)) { restream("shorter"); return true; }
        if (RX.goOn.test(text) || RX.yes.test(text)) { restream("continue"); return true; }
      }
      if (intent.intent === "explanation" && long) { setPhase("explain_back"); void grade(text, "explain_back"); return true; }
      if (/\?\s*$/.test(text) || intent.intent === "unclear") { restream("question", { question: text }); return true; }
      return false;
    }

    if (ph === "summary") {
      if (returnTo && (RX.goBack.test(text) || RX.yes.test(text))) { router.push(`/session/${returnTo.id}`); return true; }
      if (RX.next.test(text) || ctrl === "next") { void goNext(); return true; }
      if (gapsLeft > 0 && (RX.yes.test(text) || RX.fix.test(text))) { startBuddy(true); return true; }
      return false;
    }
    return false;
  };

  const hint = (() => {
    const o = offer;
    if (o?.kind === "root") return `Say "yes" to fix ${o.root.name} first, or "no" to keep going`;
    if (o?.kind === "continue") return `Say "go on" for more, or "explain it back"`;
    if (o?.kind === "keep_shorter") return `Say "yes" to keep things shorter, or "no"`;
    if (o?.kind === "buddy_again") return `Say "yes" for another angle, or "no" to finish`;
    switch (phase) {
      case "explain":
        return `Explaining ${topic.name}… say "done" when finished`;
      case "explain_back":
        return `Explaining ${topic.name} back… say "done" when finished`;
      case "grading":
        return gradeError ? `Say "try again" to retry` : "Checking against your notes…";
      case "result":
        return gapsLeft ? `Say "yes" to fix your gaps, or "explain it back"` : `Say "next" for your summary`;
      case "buddy":
        return buddy.streaming || voice.speaking
          ? `Interrupt any time: "why?", "example", "shorter", "I still don't get it"`
          : `Ask anything, or say "explain it back" when ready`;
      case "summary":
        return returnTo ? `Say "go back" to return to ${returnTo.name}, or "next"` : `Say "next" for the next topic, "start again", or "home"`;
    }
  })();

  useVoiceScreen({
    hint,
    mode: phase === "explain" || phase === "explain_back" ? "explain" : phase === "summary" ? "browse" : "buddy",
    subjectId: topic.subjectId,
    topicId: topic.id,
    onInput,
  });

  // ---------- render ----------

  const masteryCounts = useMemo(() => {
    const counts: Record<Mastery, number> = { red: 0, amber: 0, green: 0 };
    for (const c of shownClaims) counts[last?.mastery[c.id] ?? c.mastery] += 1;
    return counts;
  }, [last, shownClaims]);

  const activeStep = STEPS.findIndex((s) => s.key.includes(phase));
  const reviewCount = kind === "review" && onlyClaimIds ? onlyClaimIds.length : undefined;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={`/topics/${topic.id}`} className="text-sm text-muted hover:text-fg">
          ← {topic.name}
        </Link>
        <ol className="flex flex-wrap gap-1 text-xs" aria-label="Session progress">
          {STEPS.map((s, i) => (
            <li
              key={s.label}
              aria-current={i === activeStep ? "step" : undefined}
              className={`rounded-full px-2 py-0.5 ${i === activeStep ? "bg-accent text-accent-fg" : i < activeStep ? "bg-surface-2 text-fg" : "text-muted"}`}
            >
              {s.label}
            </li>
          ))}
        </ol>
      </div>

      {returnTo && phase !== "summary" && (
        <p className="rounded-xl bg-surface-2 px-3 py-2 text-sm">
          Fixing a root gap first. You&apos;ll go back to <strong>{returnTo.name}</strong> after.
        </p>
      )}

      {offer?.kind === "root" && (
        <div className="card space-y-3 border-accent/60" role="alert">
          <p className="text-lg">
            You might be stuck on <strong>{topic.name}</strong> because <strong>{offer.root.name}</strong> isn&apos;t solid yet.
          </p>
          {offer.root.mastery && <MasteryBadge mastery={offer.root.mastery} />}
          <p>Want to fix {offer.root.name} first? It&apos;ll take about 3 minutes.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" onClick={() => acceptOffer(offer)}>
              Yes, fix {offer.root.name}
            </button>
            <button type="button" className="btn-ghost" onClick={() => declineOffer(offer)}>
              No, keep going
            </button>
            <Link href={`/graph/${topic.subjectId}?trace=${topic.id}`} className="btn-ghost">
              Show graph
            </Link>
          </div>
        </div>
      )}

      {(phase === "explain" || phase === "explain_back") && (
        <ExplainPanel
          topicName={topic.name}
          back={phase === "explain_back"}
          reviewCount={reviewCount}
          isDemo={isDemo}
          suggesting={suggesting}
          suggestError={suggestError}
          onSuggest={suggest}
          onSkip={phase === "explain_back" ? () => void toSummary() : undefined}
        />
      )}

      {phase === "grading" && (
        <>
          <GradingPanel
            error={gradeError}
            onRetry={() => pending && void grade(pending.text, pending.kind)}
            onEdit={() => {
              setGradeError(null);
              setPhase(pending?.kind === "explain_back" ? "explain_back" : "explain");
              if (pending) voice.setInput(pending.text, false);
            }}
          />
          {pending && (
            <details className="card text-sm">
              <summary className="cursor-pointer text-muted">What you said</summary>
              <p className="mt-2 whitespace-pre-wrap break-words">{pending.text}</p>
            </details>
          )}
        </>
      )}

      {phase === "result" && last && (
        <>
          <ResultView
            claims={shownClaims}
            attempt={last}
            prev={prevForLast}
            primarySourceId={primarySourceId}
            onAppeal={(cid, n) => appeal(last.attemptId, cid, n)}
          />
          <div className="grid gap-2 sm:grid-cols-2">
            {gapsLeft > 0 ? (
              <>
                <button type="button" className="btn-primary py-3 text-base" onClick={() => startBuddy(last.kind === "explain_back")}>
                  {last.kind === "explain_back" ? "Try a different angle" : `Fix my ${gapsLeft} gap${gapsLeft === 1 ? "" : "s"}`}
                </button>
                <button type="button" className="btn-ghost py-3 text-base" onClick={last.kind === "explain_back" ? () => void toSummary() : goExplainBack}>
                  {last.kind === "explain_back" ? "Finish session" : "Explain it back now"}
                </button>
              </>
            ) : (
              <button type="button" className="btn-primary py-3 text-base sm:col-span-2" onClick={() => void toSummary()}>
                See summary
              </button>
            )}
          </div>
        </>
      )}

      {phase === "buddy" && (
        <>
          <BuddyPanel buddy={buddy} note={note} onExplainBack={goExplainBack} />
          {offer?.kind === "continue" && (
            <button type="button" className="btn-ghost w-full" onClick={() => acceptOffer(offer)}>
              Go on
            </button>
          )}
          {offer?.kind === "keep_shorter" && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary" onClick={() => acceptOffer(offer)}>
                Yes, keep it shorter
              </button>
              <button type="button" className="btn-ghost" onClick={() => declineOffer(offer)}>
                No thanks
              </button>
            </div>
          )}
          {last && (
            <details className="card">
              <summary className="cursor-pointer text-sm text-muted">Your diagnosis ({gapsLeft} gap{gapsLeft === 1 ? "" : "s"})</summary>
              <div className="mt-3">
                <ResultView compact claims={shownClaims} attempt={last} primarySourceId={primarySourceId} onAppeal={(cid, n) => appeal(last.attemptId, cid, n)} />
              </div>
            </details>
          )}
        </>
      )}

      {phase !== "buddy" && note && (
        <p className="rounded-xl bg-surface-2 px-3 py-2 text-sm" role="status">
          {note}
        </p>
      )}

      {phase === "summary" && summary && (
        <SummaryCard
          topicName={topic.name}
          fixed={
            attempts.length > 1 && last
              ? last.result.claims.filter((c) => c.status === "covered" && attempts[0].result.claims.find((f) => f.claim_id === c.claim_id)?.status !== "covered").length
              : 0
          }
          coveredNow={last ? last.result.claims.filter((c) => c.status === "covered").length : 0}
          total={last ? last.result.claims.length : shownClaims.length}
          durationMs={summary.endedAt - summary.startedAt}
          masteryCounts={masteryCounts}
          streak={summary.streak}
          next={summary.next}
          returnTo={returnTo}
          gapsLeft={gapsLeft}
          onBuddyAgain={() => startBuddy(true)}
          onStartAgain={startAgain}
        />
      )}
    </div>
  );
}
