"use client";
// Text-to-speech for the Voice Box: Web Speech sentence by sentence (or premium /api/tts audio), interruptible.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SpeakOptions } from "@/lib/voice/context";
import { splitSentences, cleanForSpeech, hasDevanagari } from "@/lib/voice/sentences";

export interface SpeakerSettings { voiceRate: number; premiumVoice: boolean; voiceName?: string }

const RATE_KEY = "samjha.voiceRate";
const MIN_RATE = 0.6;
const MAX_RATE = 1.8;

interface Playing { sents: string[]; opts?: SpeakOptions; index: number; lang: string }

function langFromName(name?: string): string {
  const n = (name ?? "").toLowerCase();
  if (/hindi|hinglish/.test(n)) return "hi-IN";
  return "en-IN";
}

function resolveLang(opt: string | undefined, text: string, userLanguage?: string): string {
  if (opt) return /^[a-z]{2,3}(?:[-_][a-z]{2,4})?$/i.test(opt) && !/^(?:hindi|english)$/i.test(opt) ? opt.replace("_", "-") : langFromName(opt);
  if (hasDevanagari(text)) return "hi-IN";
  return langFromName(userLanguage);
}

const normLang = (l: string) => l.replace("_", "-").toLowerCase();

export function pickVoice(voices: SpeechSynthesisVoice[], lang: string, preferredName?: string): SpeechSynthesisVoice | null {
  const want = normLang(lang);
  const base = want.slice(0, 2);
  if (preferredName) {
    const v = voices.find((x) => x.name === preferredName);
    if (v && normLang(v.lang).startsWith(base)) return v;
  }
  const rank = (v: SpeechSynthesisVoice) => (/google|natural|neural|online|premium|enhanced/i.test(v.name) ? 0 : 1) + (v.localService ? 0 : 0.1);
  const best = (pred: (v: SpeechSynthesisVoice) => boolean) => voices.filter(pred).sort((a, b) => rank(a) - rank(b))[0] ?? null;
  return (
    best((v) => normLang(v.lang) === want) ??
    best((v) => normLang(v.lang).startsWith(base)) ??
    best((v) => normLang(v.lang) === "en-in") ??
    best((v) => normLang(v.lang).startsWith("en")) ??
    null
  );
}

const noSubscribe = () => () => {};

/** Load and start one clip on the shared audio element; a failed play() counts as an error. */
function playAudio(a: HTMLAudioElement, url: string, rate: number, on: { onEnded: () => void; onError: () => void }) {
  a.src = url;
  a.playbackRate = rate;
  a.onended = on.onEnded;
  a.onerror = on.onError;
  a.play().catch(on.onError);
}

function readStoredRate(): number | null {
  try {
    const v = Number(localStorage.getItem(RATE_KEY));
    return Number.isFinite(v) && v >= MIN_RATE && v <= MAX_RATE ? v : null;
  } catch {
    return null;
  }
}

export function useSpeaker(userLanguage: string | undefined, settings: SpeakerSettings) {
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [sentenceIndex, setSentenceIndex] = useState(-1);
  // Speed priority: a change made by voice in this session, then the speed stored on this device,
  // then the server setting. The stored value is null during hydration, as on the server.
  const [userRate, setUserRate] = useState<number | null>(null);
  const storedRate = useSyncExternalStore(noSubscribe, readStoredRate, () => null);
  const rate = userRate ?? storedRate ?? Math.min(MAX_RATE, Math.max(MIN_RATE, settings.voiceRate || 1));

  const settingsRef = useRef(settings);
  const rateRef = useRef(rate);
  useLayoutEffect(() => {
    settingsRef.current = settings;
    rateRef.current = rate;
  }, [settings, rate]);
  const gen = useRef(0);
  const playing = useRef<Playing | null>(null);
  const pausedAt = useRef<Playing | null>(null);
  const last = useRef<{ text: string; opts?: SpeakOptions } | null>(null);
  const voices = useRef<SpeechSynthesisVoice[]>([]);
  const utter = useRef<SpeechSynthesisUtterance | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const premiumOk = useRef(true);
  const ttsCache = useRef(new Map<string, Promise<string | null>>());

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const load = () => (voices.current = window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener?.("voiceschanged", load);
    return () => {
      window.speechSynthesis.removeEventListener?.("voiceschanged", load);
      window.speechSynthesis.cancel();
    };
  }, []);

  const silence = useCallback(() => {
    gen.current++;
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    const a = audio.current;
    if (a) {
      a.onended = null;
      a.onerror = null;
      a.pause();
    }
  }, []);

  const clearCache = useCallback(() => {
    for (const p of ttsCache.current.values()) p.then((u) => u && URL.revokeObjectURL(u)).catch(() => {});
    ttsCache.current.clear();
  }, []);

  const finish = useCallback((g: number) => {
    if (g !== gen.current) return;
    const p = playing.current;
    playing.current = null;
    setSpeaking(false);
    setSentenceIndex(-1);
    p?.opts?.onEnd?.();
  }, []);

  const fetchTts = useCallback((text: string): Promise<string | null> => {
    const hit = ttsCache.current.get(text);
    if (hit) return hit;
    const p = fetch("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) })
      .then(async (r) => {
        if (r.status === 501) premiumOk.current = false;
        if (!r.ok) return null;
        return URL.createObjectURL(await r.blob());
      })
      .catch(() => null);
    ttsCache.current.set(text, p);
    return p;
  }, []);

  // playWeb/playPremium continue through the latest speakFrom (defined below).
  const speakFromRef = useRef<(g: number, i: number) => void>(() => {});
  const next = (g: number, i: number) => speakFromRef.current(g, i);

  const playWeb = (g: number, i: number, said: string, lang: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      next(g, i + 1);
      return;
    }
    const synth = window.speechSynthesis;
    const u = new SpeechSynthesisUtterance(said);
    const l = hasDevanagari(said) ? "hi-IN" : lang;
    if (!voices.current.length) voices.current = synth.getVoices();
    const v = pickVoice(voices.current, l, settingsRef.current.voiceName);
    if (v) u.voice = v;
    u.lang = v?.lang ?? l;
    u.rate = rateRef.current;
    u.onend = () => {
      if (g === gen.current) next(g, i + 1);
    };
    u.onerror = (e) => {
      if (g !== gen.current || e.error === "interrupted" || e.error === "canceled") return;
      next(g, i + 1);
    };
    utter.current = u; // keep a reference so Chrome doesn't GC it before onend
    if (synth.paused) synth.resume();
    synth.speak(u);
  };

  const playPremium = async (g: number, i: number, said: string, lang: string) => {
    const p = playing.current;
    const nextText = p && i + 1 < p.sents.length ? cleanForSpeech(p.sents[i + 1]) : "";
    const url = await fetchTts(said);
    if (nextText) void fetchTts(nextText);
    if (g !== gen.current) return;
    if (!url) {
      playWeb(g, i, said, lang);
      return;
    }
    const a = audio.current ?? (audio.current = new Audio());
    playAudio(a, url, rateRef.current, {
      onEnded: () => {
        if (g === gen.current) next(g, i + 1);
      },
      onError: () => {
        if (g === gen.current) playWeb(g, i, said, lang);
      },
    });
  };

  const speakFrom = (g: number, i: number) => {
    const p = playing.current;
    if (!p || g !== gen.current) return;
    if (i >= p.sents.length) {
      finish(g);
      return;
    }
    const said = cleanForSpeech(p.sents[i]);
    if (!said || !/[\p{L}\p{N}]/u.test(said)) {
      speakFrom(g, i + 1);
      return;
    }
    p.index = i;
    setSentenceIndex(i);
    p.opts?.onSentence?.(i);
    if (settingsRef.current.premiumVoice && premiumOk.current) void playPremium(g, i, said, p.lang);
    else playWeb(g, i, said, p.lang);
  };

  useLayoutEffect(() => {
    speakFromRef.current = speakFrom;
  });

  const stop = useCallback(() => {
    silence();
    playing.current = null;
    pausedAt.current = null;
    setSpeaking(false);
    setPaused(false);
    setSentenceIndex(-1);
    clearCache();
  }, [silence, clearCache]);

  const speak = useCallback(
    (text: string, opts?: SpeakOptions) => {
      stop();
      const sents = splitSentences(text);
      if (!sents.length) return;
      last.current = { text, opts };
      playing.current = { sents, opts, index: 0, lang: resolveLang(opts?.lang, text, userLanguage) };
      const g = gen.current;
      setSpeaking(true);
      speakFromRef.current(g, 0);
    },
    [stop, userLanguage],
  );

  const pause = useCallback((): boolean => {
    const p = playing.current;
    if (!p) return false;
    silence();
    pausedAt.current = p;
    playing.current = null;
    setSpeaking(false);
    setPaused(true);
    return true;
  }, [silence]);

  const resume = useCallback((): boolean => {
    const p = pausedAt.current;
    if (!p) return false;
    pausedAt.current = null;
    playing.current = p;
    const g = ++gen.current;
    setPaused(false);
    setSpeaking(true);
    speakFromRef.current(g, p.index);
    return true;
  }, []);

  const repeat = useCallback((): boolean => {
    const l = last.current;
    if (!l) return false;
    speak(l.text, l.opts);
    return true;
  }, [speak]);

  /** Change speed by a step (negative = slower). Restarts the current sentence at the new speed. */
  const changeRate = useCallback((delta: number): number => {
    const r = Math.round(Math.min(MAX_RATE, Math.max(MIN_RATE, rateRef.current + delta)) * 100) / 100;
    rateRef.current = r;
    setUserRate(r);
    try {
      localStorage.setItem(RATE_KEY, String(r));
    } catch {}
    const p = playing.current;
    if (p) {
      silence();
      speakFromRef.current(gen.current, p.index);
    }
    return r;
  }, [silence]);

  return { speak, stop, pause, resume, repeat, changeRate, speaking, paused, sentenceIndex, rate, hasLast: () => !!last.current };
}
