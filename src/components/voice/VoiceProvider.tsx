"use client";
// The always-present Voice Box (spec §5). Wispr Flow dictates into the textarea; we auto-submit after an idle pause,
// classify the text (rules on the client first), let the active screen handle it, and handle navigation/control globally.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { VoiceContext, type VoiceApi, type VoiceScreen, type SpeakOptions } from "@/lib/voice/context";
import type { IntentResult } from "@/lib/types";
import { splitSentences } from "@/lib/voice/sentences";
import {
  classifyRules,
  classifyContext,
  heuristicIntent,
  normalize,
  wordCount,
  stripTrailingDone,
  stripTrailingSend,
  type IntentCtx,
} from "@/lib/intent/rules";
import { useSpeaker } from "./useSpeaker";

interface VoiceSettings { autoSubmitMs: number; submitMode: "pause" | "say_send"; voiceRate: number; premiumVoice: boolean; voiceName?: string }
const DEFAULT_SETTINGS: VoiceSettings = { autoSubmitMs: 1500, submitMode: "pause", voiceRate: 1, premiumVoice: false };
const SETTINGS_KEY = "samjha.voiceSettings";
const UNCLEAR_Q = "Did you want me to change the style, or is that part of your explanation?";
const DEFAULT_HINT = "Hold your dictation key and speak, or type. Try “what should I study?”";

interface Notice { id: number; text: string; actions?: { label: string; run: () => void }[] }

function parseSettings(raw: unknown): VoiceSettings {
  const src = (raw && typeof raw === "object" && "settings" in raw ? (raw as { settings: unknown }).settings : raw) as Partial<VoiceSettings> | null;
  const s = src && typeof src === "object" ? src : {};
  const ms = Number(s.autoSubmitMs);
  const rate = Number(s.voiceRate);
  return {
    autoSubmitMs: Number.isFinite(ms) && ms >= 300 && ms <= 10000 ? ms : DEFAULT_SETTINGS.autoSubmitMs,
    submitMode: s.submitMode === "say_send" ? "say_send" : "pause",
    voiceRate: Number.isFinite(rate) && rate > 0 ? rate : 1,
    premiumVoice: s.premiumVoice === true,
    voiceName: typeof s.voiceName === "string" && s.voiceName ? s.voiceName : undefined,
  };
}

const noSubscribe = () => () => {};
function readCachedSettings(): string | null {
  try {
    return localStorage.getItem(SETTINGS_KEY);
  } catch {
    return null;
  }
}

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !["button", "submit", "reset", "checkbox", "radio", "range", "file", "color", "image"].includes(el.type);
  return (el as HTMLElement).isContentEditable === true;
}

type TopicHit = { id: string; name?: string };
function firstTopic(j: unknown): TopicHit | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const list = Array.isArray(j) ? j : Array.isArray(o.topics) ? o.topics : Array.isArray(o.results) ? o.results : o.topic ? [o.topic] : o.id ? [o] : [];
  const t = list[0] as Record<string, unknown> | undefined;
  return t && typeof t.id === "string" ? { id: t.id, name: typeof t.name === "string" ? t.name : undefined } : null;
}

const explanationIntent = (): IntentResult => ({ intent: "explanation", args: {}, confidence: 1, source: "context" });

export function VoiceProvider({ children, userLanguage }: { children: React.ReactNode; userLanguage?: string }) {
  const router = useRouter();
  const pathname = usePathname();

  // Settings: the server copy once fetched, else this device's cached copy (null during hydration,
  // matching the server render), else defaults.
  const cachedRaw = useSyncExternalStore(noSubscribe, readCachedSettings, () => null);
  const cachedSettings = useMemo(() => {
    if (!cachedRaw) return null;
    try {
      return parseSettings(JSON.parse(cachedRaw));
    } catch {
      return null;
    }
  }, [cachedRaw]);
  const [fetchedSettings, setSettings] = useState<VoiceSettings | null>(null);
  const settings = fetchedSettings ?? cachedSettings ?? DEFAULT_SETTINGS;
  const [screen, setScreen] = useState<VoiceScreen | null>(null);
  const [value, setValue] = useState("");
  const [draft, setDraft] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const [focused, setFocused] = useState(false);
  const [kbOffset, setKbOffset] = useState(0);
  const [heard, setHeard] = useState("");

  const speaker = useSpeaker(userLanguage, settings);
  const stopAudio = speaker.stop;
  const speakFn = speaker.speak;

  const settingsRef = useRef(settings);
  useLayoutEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  const screenRef = useRef<VoiceScreen | null>(null);
  const valueRef = useRef("");
  const draftRef = useRef<string[]>([]);
  const pendingUnclear = useRef<string | null>(null);
  const submitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTyped = useRef(0);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const noticeId = useRef(0);

  // ---------- settings ----------
  useEffect(() => {
    let alive = true;
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: unknown) => {
        if (!alive) return;
        const s = parseSettings(j);
        setSettings(s);
        try {
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
        } catch {}
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // ---------- small helpers ----------
  const focusBox = useCallback(() => {
    const ta = taRef.current;
    if (!ta || typeof window === "undefined") return;
    if (!window.matchMedia?.("(pointer: fine)").matches) return; // don't pop the phone keyboard on every action
    const ae = document.activeElement;
    if (ae && ae !== ta && isEditable(ae)) return;
    ta.focus({ preventScroll: true });
  }, []);

  const showNotice = useCallback((text: string, actions?: Notice["actions"]) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    const id = ++noticeId.current;
    setNotice({ id, text, actions });
    if (!actions) noticeTimer.current = setTimeout(() => setNotice((n) => (n?.id === id ? null : n)), 6000);
  }, []);

  const say = useCallback(
    (text: string) => {
      showNotice(text);
      speaker.speak(text);
    },
    [showNotice, speaker],
  );

  const setDraftPieces = (pieces: string[]) => {
    draftRef.current = pieces;
    setDraft(pieces);
  };

  const clearTimers = () => {
    if (submitTimer.current) clearTimeout(submitTimer.current);
    submitTimer.current = null;
    setWaiting(false);
  };
  const clearDraftTimer = () => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = null;
  };

  const ctxNow = (): IntentCtx & { mode: VoiceScreen["mode"] } => {
    const s = screenRef.current;
    return { mode: s?.mode ?? "browse", hasTopic: !!s?.topicId };
  };

  const withBusy = async <T,>(fn: () => Promise<T>): Promise<T> => {
    setBusy((b) => b + 1);
    try {
      return await fn();
    } finally {
      setBusy((b) => b - 1);
    }
  };

  // ---------- global actions ----------
  const applyStyle = async (text: string): Promise<boolean> => {
    try {
      const r = await withBusy(() =>
        fetch("/api/prefs/command", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, subjectId: screenRef.current?.subjectId }),
        }),
      );
      const j = (await r.json().catch(() => ({}))) as { applied?: boolean; confirmation?: string };
      if (r.ok && j.applied) {
        say(j.confirmation || "Got it.");
        return true;
      }
      showNotice("I couldn't change the style from that. Try “use a cricket analogy” or “in Hinglish”.");
    } catch {
      showNotice("Couldn't save that preference. Check your connection and try again.");
    }
    return false;
  };

  const goStudyNext = async () => {
    try {
      const r = await withBusy(() => fetch("/api/study/next"));
      const j = (await r.json().catch(() => ({}))) as { topicId?: string; name?: string; reason?: string };
      if (r.ok && j.topicId) {
        say(j.reason || `Let's do ${j.name ?? "this one"}.`);
        router.push(`/session/${j.topicId}`);
      } else {
        say("Nothing urgent right now. Upload more notes or review what's due.");
      }
    } catch {
      showNotice("Couldn't pick a topic right now. Try again in a moment.");
    }
  };

  const openTopic = async (q: string) => {
    try {
      const r = await withBusy(() => fetch(`/api/topics/search?q=${encodeURIComponent(q)}`));
      const t = r.ok ? firstTopic(await r.json().catch(() => null)) : null;
      if (t) {
        showNotice(`Opening ${t.name ?? q}…`);
        router.push(`/topics/${t.id}`);
      } else {
        say(`I couldn't find “${q}” in your notes.`);
      }
    } catch {
      showNotice("Search failed. Try again in a moment.");
    }
  };

  const navigate = async (args: IntentResult["args"]) => {
    const s = screenRef.current;
    const go = (href: string) => router.push(href);
    switch (args.target) {
      case "topic":
        if (typeof args.topic === "string" && args.topic) await openTopic(args.topic);
        else showNotice("Which topic? Say “open” and the topic name.");
        return;
      case "study_next":
      case "next_topic":
        return goStudyNext();
      case "home":
        return go("/home");
      case "review":
        return go("/review?start=1");
      case "exam_eve":
        return go("/exam-eve");
      case "graph":
        if (s?.subjectId) return go(`/graph/${s.subjectId}${args.trace && s.topicId ? `?trace=${s.topicId}` : ""}`);
        showNotice("Open a subject or topic first to see its concept graph.");
        return go("/home");
      case "viva":
        return go("/viva");
      case "settings":
        return go("/settings");
      case "style":
        return go("/style");
      case "upload":
        return go("/subjects/new");
      case "notes":
        if (s?.topicId) return go(`/topics/${s.topicId}`);
        showNotice("Open a topic first, then say “show my notes”.");
        return;
      default:
        showNotice("I'm not sure where to go. Try “show my heatmap” or “open” and a topic.");
    }
  };

  const control = async (action: unknown) => {
    switch (action) {
      case "stop":
        speaker.stop();
        return;
      case "repeat":
        if (!speaker.repeat()) showNotice("Nothing to repeat yet.");
        return;
      case "slower":
      case "faster": {
        const r = speaker.changeRate(action === "slower" ? -0.15 : 0.15);
        showNotice(`Voice speed ${r.toFixed(2)}×`);
        return;
      }
      case "pause":
        if (!speaker.pause()) showNotice("Nothing is playing.");
        return;
      case "resume":
        if (!speaker.resume()) showNotice("Nothing to resume.");
        return;
      case "done":
      case "send":
        if (draftRef.current.length) return finalizeDraft();
        return;
      case "next":
        return goStudyNext();
    }
  };

  const handleGlobal = async (text: string, r: IntentResult) => {
    switch (r.intent) {
      case "navigation":
        return navigate(r.args);
      case "control":
        return control(r.args.action);
      case "style":
        await applyStyle(text);
        return;
      case "scope":
        if (!(await applyStyle(text))) showNotice("That works inside a session. Open a topic first.");
        return;
      case "interrupt":
        showNotice("Open a topic first and I can answer that. Or say “what should I study?”");
        return;
      case "explanation":
        showNotice("To get graded, open a topic first: say “open” and the topic name.");
        return;
    }
  };

  const askUnclear = (text: string) => {
    const { mode, hasTopic } = ctxNow();
    if (mode === "explain" || mode === "buddy" || mode === "review" || hasTopic) {
      pendingUnclear.current = text;
      showNotice(UNCLEAR_Q, [
        {
          label: "Change the style",
          run: () => {
            pendingUnclear.current = null;
            setNotice(null);
            void applyStyle(text).finally(focusBox);
          },
        },
        {
          label: "Part of my explanation",
          run: () => {
            pendingUnclear.current = null;
            setNotice(null);
            void treatAsExplanation(text).finally(focusBox);
          },
        },
      ]);
      speaker.speak(UNCLEAR_Q);
    } else {
      say("Sorry, I didn't catch that. Try “open” and a topic name, or “what should I study?”");
    }
  };

  const dispatch = async (text: string, r: IntentResult): Promise<void> => {
    const s = screenRef.current;
    if (s) {
      try {
        const handled = await withBusy(async () => s.onInput(text, r));
        if (handled === true) return;
      } catch (e) {
        console.error("[samjha voice] screen handler failed", e);
        showNotice("Something went wrong handling that. Try again.");
        return;
      }
    }
    if (r.intent === "unclear") return askUnclear(text);
    await handleGlobal(text, r);
  };

  // ---------- explain-mode draft ----------
  const finalizeDraft = async () => {
    clearDraftTimer();
    const joined = draftRef.current.join(" ").replace(/\s+/g, " ").trim();
    setDraftPieces([]);
    if (joined) await dispatch(joined, explanationIntent());
  };

  const armDraftTimer = () => {
    clearDraftTimer();
    if (!draftRef.current.length) return;
    draftTimer.current = setTimeout(() => void api.current.finalizeDraft(), settingsRef.current.autoSubmitMs * 3);
  };

  const appendDraft = (text: string) => {
    const t = text.trim();
    if (t) setDraftPieces([...draftRef.current, t]);
  };

  const treatAsExplanation = async (text: string) => {
    if (ctxNow().mode === "explain") {
      appendDraft(text);
      armDraftTimer();
      return;
    }
    await dispatch(text, explanationIntent());
  };

  const processExplain = async (text: string, ctx: IntentCtx, final: boolean) => {
    const r = classifyRules(text, ctx);
    if (r?.intent === "control" && (r.args.action === "done" || r.args.action === "send")) {
      if (draftRef.current.length) return finalizeDraft();
      return dispatch(text, r);
    }
    if (r && r.intent !== "explanation") return dispatch(text, r);
    const rest = stripTrailingDone(text);
    if (rest !== null) {
      appendDraft(rest);
      return finalizeDraft();
    }
    appendDraft(text);
    if (final) return finalizeDraft();
    armDraftTimer();
  };

  // ---------- submission pipeline ----------
  const classifyRemote = async (text: string, ctx: IntentCtx): Promise<IntentResult> => {
    try {
      const r = await withBusy(() =>
        fetch("/api/intent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, ...ctx }) }),
      );
      if (!r.ok) throw new Error(String(r.status));
      return (await r.json()) as IntentResult;
    } catch {
      return heuristicIntent(text, ctx);
    }
  };

  const process = async (text: string, final: boolean) => {
    const ctx = ctxNow();
    setHeard(text);

    const pending = pendingUnclear.current;
    if (pending) {
      pendingUnclear.current = null;
      setNotice(null);
      const n = normalize(text);
      if (wordCount(n) <= 6 && /\bstyle\b/.test(n)) return void (await applyStyle(pending));
      if (wordCount(n) <= 6 && /\bexplanation\b|^part of (?:it|my)/.test(n)) return treatAsExplanation(pending);
    }

    if (ctx.mode === "explain") return processExplain(text, ctx, final);
    const r = classifyRules(text, ctx) ?? classifyContext(text, ctx) ?? (await classifyRemote(text, ctx));
    await dispatch(text, r);
  };

  const doSubmit = (raw: string, final: boolean) => {
    const text = raw.trim();
    clearTimers();
    valueRef.current = "";
    setValue("");
    speaker.stop();
    if (!text) return;
    void process(text, final).finally(() => api.current.focusBox());
  };

  const autoFire = () => {
    setWaiting(false);
    submitTimer.current = null;
    const v = valueRef.current.trim();
    if (!v) return;
    if (settingsRef.current.submitMode === "say_send") {
      const rest = stripTrailingSend(v);
      if (rest === null) return;
      if (!rest) {
        if (draftRef.current.length) {
          valueRef.current = "";
          setValue("");
          void finalizeDraft();
        }
        return;
      }
      doSubmit(rest, true);
      return;
    }
    doSubmit(v, false);
  };

  const schedule = () => {
    if (submitTimer.current) clearTimeout(submitTimer.current);
    if (!valueRef.current.trim()) {
      setWaiting(false);
      return;
    }
    const ms = settingsRef.current.autoSubmitMs;
    const typing = Date.now() - lastTyped.current < 250;
    const delay = typing ? Math.max(ms * 2, 3000) : ms;
    setWaiting(settingsRef.current.submitMode === "pause");
    submitTimer.current = setTimeout(() => api.current.autoFire(), delay);
  };

  // Latest closures for timers and the stable context API. Refreshed in a layout effect after
  // every commit, so timers, DOM events and context callers always reach the newest handlers.
  const api = useRef({ finalizeDraft, autoFire, focusBox, doSubmit, process });
  useLayoutEffect(() => {
    api.current = { finalizeDraft, autoFire, focusBox, doSubmit, process };
  });

  // ---------- textarea events ----------
  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    const grew = v.length > valueRef.current.length;
    valueRef.current = v;
    setValue(v);
    if (grew) {
      speaker.stop(); // new input interrupts audio immediately (spec §5.3)
      clearDraftTimer();
      if (pendingUnclear.current && notice?.actions) {
        /* keep the question visible; the next submission answers it */
      }
    }
    if (!v.trim() && draftRef.current.length) armDraftTimer();
    schedule();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      doSubmit(valueRef.current, true);
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) lastTyped.current = Date.now();
  };

  // auto-grow
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, Math.round(window.innerHeight * 0.35))}px`;
  }, [value]);

  // Esc stops audio anywhere; typing/pasting with nothing focused goes into the Voice Box; refocus after clicks.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        stopAudio();
        return;
      }
      const ae = document.activeElement;
      if (isEditable(ae)) return;
      const paste = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v";
      if (paste || (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " ")) taRef.current?.focus({ preventScroll: true });
    };
    const onClick = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t && (isEditable(t) || t.closest?.("[data-voice-keep-focus]"))) return;
      setTimeout(() => api.current.focusBox(), 0);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, [stopAudio]);

  // Keep the box above the on-screen keyboard.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const f = () => setKbOffset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    f();
    vv.addEventListener("resize", f);
    vv.addEventListener("scroll", f);
    return () => {
      vv.removeEventListener("resize", f);
      vv.removeEventListener("scroll", f);
    };
  }, []);

  // New screen: drop half-finished drafts/questions and refocus. Visible state resets during the
  // render that sees the new path; refs and timers reset in the effect after it commits.
  const [screenPath, setScreenPath] = useState(pathname);
  if (pathname !== screenPath) {
    setScreenPath(pathname);
    setDraft([]);
    setNotice((n) => (n?.actions ? null : n));
  }
  useEffect(() => {
    clearDraftTimer();
    draftRef.current = [];
    pendingUnclear.current = null;
    const t = setTimeout(() => api.current.focusBox(), 50);
    return () => clearTimeout(t);
  }, [pathname]);

  useEffect(
    () => () => {
      clearTimers();
      clearDraftTimer();
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ---------- context API ----------
  const register = useCallback((s: VoiceScreen | null) => {
    screenRef.current = s;
    setScreen(s);
  }, []);

  const setInput = useCallback(
    (text: string, submit?: boolean) => {
      stopAudio();
      if (submit) {
        api.current.doSubmit(text, wordCount(text) >= 20);
        return;
      }
      valueRef.current = text;
      setValue(text);
      setTimeout(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(text.length, text.length);
      }, 0);
    },
    [stopAudio],
  );

  const submit = useCallback((text: string) => api.current.doSubmit(text, wordCount(text) >= 20), []);
  const speakApi = useCallback((text: string, opts?: SpeakOptions) => speakFn(text, opts), [speakFn]);

  const ctxValue = useMemo<VoiceApi>(
    () => ({
      speak: speakApi,
      stop: speaker.stop,
      speaking: speaker.speaking,
      sentenceIndex: speaker.sentenceIndex,
      sentences: splitSentences,
      setInput,
      submit,
      register,
    }),
    [speakApi, speaker.stop, speaker.speaking, speaker.sentenceIndex, setInput, submit, register],
  );

  // ---------- render ----------
  const status: { label: string; tone: string } = speaker.speaking
    ? { label: "Speaking", tone: "bg-accent" }
    : speaker.paused
      ? { label: "Paused", tone: "bg-amber" }
      : busy > 0
        ? { label: "Thinking…", tone: "bg-amber animate-pulse" }
        : waiting
          ? { label: "Got it, sending…", tone: "bg-green animate-pulse" }
          : focused
            ? { label: "Listening", tone: "bg-green" }
            : { label: "Click to talk", tone: "bg-muted" };

  const hint = screen?.hint || DEFAULT_HINT;
  const boxPrompt =
    settings.submitMode === "say_send" ? "Speak or type… say “send” to submit" : screen?.mode === "explain" ? "Start explaining… say “done” when finished" : "Speak or type…";

  return (
    <VoiceContext.Provider value={ctxValue}>
      {children}
      <section
        aria-label="Voice Box"
        className="fixed inset-x-0 z-40 border-t border-line bg-bg/95 backdrop-blur"
        style={{ bottom: kbOffset }}
      >
        <div className="mx-auto w-full max-w-5xl px-4 pt-2" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
          {draft.length > 0 && (
            <div className="mb-2 rounded-xl border border-line bg-surface p-3" aria-live="polite">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">Your explanation so far</span>
                <div className="flex gap-2" data-voice-keep-focus>
                  <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setDraftPieces([])}>
                    Clear
                  </button>
                  <button type="button" className="btn-primary px-2 py-1 text-xs" onClick={() => void finalizeDraft().finally(focusBox)}>
                    I&apos;m done
                  </button>
                </div>
              </div>
              <p className="max-h-32 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed">{draft.join(" ")}</p>
            </div>
          )}

          {notice && (
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm" role="status" aria-live="polite">
              <span className="min-w-0 flex-1">{notice.text}</span>
              {notice.actions?.map((a) => (
                <button key={a.label} type="button" className="btn-ghost px-3 py-1 text-xs" onClick={a.run}>
                  {a.label}
                </button>
              ))}
              {notice.actions && (
                <button type="button" className="px-1 text-muted hover:text-fg" aria-label="Dismiss" onClick={() => setNotice(null)}>
                  ×
                </button>
              )}
            </div>
          )}

          <div className="mb-1.5 flex items-center gap-2 text-xs text-muted">
            <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${status.tone}`} aria-hidden />
            <span className="shrink-0 font-medium text-fg" aria-live="polite">
              {status.label}
            </span>
            <span className="min-w-0 flex-1 truncate" title={hint}>
              · {hint}
            </span>
            {heard && !speaker.speaking && busy === 0 && (
              <span className="hidden max-w-[40%] truncate italic sm:inline" title={heard}>
                Heard: “{heard}”
              </span>
            )}
          </div>

          <div className="flex items-end gap-2">
            <label htmlFor="samjha-voice-box" className="sr-only">
              Voice Box: speak with your dictation key or type
            </label>
            <textarea
              id="samjha-voice-box"
              ref={taRef}
              value={value}
              onChange={onChange}
              onKeyDown={onKeyDown}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              rows={2}
              autoFocus
              placeholder={boxPrompt}
              className="input min-h-[3.5rem] flex-1 resize-none py-3 text-lg leading-snug"
              aria-describedby="samjha-voice-hint"
            />
            <span id="samjha-voice-hint" className="sr-only">
              {hint}. Enter sends, Shift+Enter adds a new line, Escape stops audio.
            </span>
            <div className="flex shrink-0 flex-col gap-2" data-voice-keep-focus>
              {(speaker.speaking || speaker.paused) && (
                <button
                  type="button"
                  className="btn-ghost h-11 w-11 p-0"
                  aria-label={speaker.paused ? "Resume audio" : "Stop audio"}
                  title={speaker.paused ? "Resume (say “resume”)" : "Stop (Esc or say “stop”)"}
                  onClick={() => {
                    if (speaker.paused) speaker.resume();
                    else speaker.stop();
                    focusBox();
                  }}
                >
                  {speaker.paused ? <PlayIcon /> : <StopIcon />}
                </button>
              )}
              <button
                type="button"
                className="btn-primary h-11 w-11 p-0"
                aria-label="Send"
                title="Send (Enter)"
                disabled={!value.trim() && !draft.length}
                onClick={() => {
                  if (value.trim()) doSubmit(value, true);
                  else void finalizeDraft().finally(focusBox);
                }}
              >
                <SendIcon />
              </button>
            </div>
          </div>
        </div>
      </section>
    </VoiceContext.Provider>
  );
}

function SendIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}
function StopIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}
function PlayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
