"use client";
// Streams /api/buddy and reads it aloud incrementally: speaks each batch of complete sentences as soon as it has
// arrived, then the next batch when the previous one finishes. Highlighting maps useVoice().sentenceIndex back to
// the raw (markdown) text via segmentRaw.
import { useCallback, useEffect, useRef, useState } from "react";
import { useVoice } from "@/lib/voice/context";
import type { Prefs } from "@/lib/types";
import type { BuddyMode } from "./types";
import { completeSentencePrefix, friendlyError, toSpeech } from "./text";

export interface BuddyStartOpts {
  topicId: string;
  attemptId: string;
  mode: BuddyMode;
  question?: string;
  oncePrefs?: Partial<Prefs>;
  differentAnalogy?: boolean;
  /** Keep the current text and append (for "go on"). */
  append?: boolean;
  /** Short line spoken before the stream (e.g. a style confirmation). Not shown in the buddy text. */
  preface?: string;
  /** Label for the history entry of the text being replaced. */
  label?: string;
}

export interface BuddyTurn { label: string; text: string }

interface Inner {
  text: string;
  spokenLen: number;
  speaking: boolean;
  done: boolean;
  batches: string[];
  preface: string | null;
  muted: boolean;
  trailer: string | null;
}

const fresh = (): Inner => ({ text: "", spokenLen: 0, speaking: false, done: false, batches: [], preface: null, muted: false, trailer: null });

export function useBuddyStream(onFinished?: (text: string, suggestion: string | null) => void) {
  const voice = useVoice();
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  const [text, setText] = useState("");
  const [batches, setBatches] = useState<string[]>([]);
  const [activeBatch, setActiveBatch] = useState(-1);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<BuddyTurn[]>([]);
  const [lastLabel, setLastLabel] = useState("Buddy");

  const gen = useRef(0);
  const st = useRef<Inner>(fresh());
  const abortRef = useRef<AbortController | null>(null);
  const lastOpts = useRef<BuddyStartOpts | null>(null);
  const lastLabelRef = useRef("Buddy");

  const pump = useCallback((g: number) => {
    const s = st.current;
    if (g !== gen.current || s.speaking || s.muted) return;
    if (s.preface) {
      const line = s.preface;
      s.preface = null;
      s.speaking = true;
      voiceRef.current.speak(line, {
        onEnd: () => {
          if (g !== gen.current) return;
          s.speaking = false;
          pump(g);
        },
      });
      return;
    }
    const rest = s.text.slice(s.spokenLen);
    const cut = s.done ? rest.length : completeSentencePrefix(rest);
    if (cut <= 0 || !toSpeech(rest.slice(0, cut))) {
      if (s.done && s.spokenLen + cut >= s.text.length) {
        s.spokenLen = s.text.length;
        setActiveBatch(-1);
        if (s.trailer) {
          const line = s.trailer;
          s.trailer = null;
          s.speaking = true;
          voiceRef.current.speak(line, { onEnd: () => { if (g === gen.current) s.speaking = false; } });
        }
      }
      return;
    }
    const chunk = rest.slice(0, cut);
    s.spokenLen += cut;
    s.batches = [...s.batches, chunk];
    setBatches(s.batches);
    setActiveBatch(s.batches.length - 1);
    s.speaking = true;
    voiceRef.current.speak(toSpeech(chunk), {
      onEnd: () => {
        if (g !== gen.current) return;
        s.speaking = false;
        if (s.done && s.spokenLen >= s.text.length) setActiveBatch(-1);
        pump(g);
      },
    });
  }, []);

  const stop = useCallback(() => {
    gen.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    voiceRef.current.stop();
    st.current.speaking = false;
    setStreaming(false);
    setActiveBatch(-1);
  }, []);

  /** Stop reading aloud but let the text keep streaming in. */
  const silence = useCallback(() => {
    st.current.muted = true;
    st.current.speaking = false;
    voiceRef.current.stop();
    setActiveBatch(-1);
  }, []);

  const start = useCallback(
    async (opts: BuddyStartOpts) => {
      stop();
      const g = gen.current;
      lastOpts.current = opts;
      setError(null);
      const prev = st.current;
      if (opts.append) {
        const sep = prev.text && !prev.text.endsWith("\n") ? "\n\n" : "";
        prev.text += sep;
        prev.done = false;
        prev.speaking = false;
        prev.preface = opts.preface ?? null;
        prev.muted = false;
      } else {
        if (prev.text.trim()) setHistory((h) => [...h, { label: lastLabelRef.current, text: prev.text }].slice(-6));
        st.current = { ...fresh(), preface: opts.preface ?? null };
        setBatches([]);
        setText("");
        lastLabelRef.current = opts.label || "Buddy";
        setLastLabel(lastLabelRef.current);
      }
      const s = st.current;
      setStreaming(true);
      pump(g);
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const res = await fetch("/api/buddy", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            topicId: opts.topicId,
            attemptId: opts.attemptId,
            mode: opts.mode,
            question: opts.question,
            oncePrefs: opts.oncePrefs,
            differentAnalogy: opts.differentAnalogy,
          }),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          const j = (await res.json().catch(() => null)) as { error?: string } | null;
          throw Object.assign(new Error(friendlyError(res.status)), { friendly: true });
        }
        const suggestion = res.headers.get("x-samjha-suggestion");
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (g !== gen.current) { reader.cancel().catch(() => {}); return; }
          if (done) break;
          s.text += dec.decode(value, { stream: true });
          setText(s.text);
          pump(g);
        }
        s.text += dec.decode();
        s.done = true;
        s.trailer = suggestion;
        setText(s.text);
        setStreaming(false);
        pump(g);
        finishedRef.current?.(s.text, suggestion);
      } catch (e) {
        if (g !== gen.current || (e instanceof DOMException && e.name === "AbortError")) return;
        setStreaming(false);
        const msg = e instanceof Error && (e as Error & { friendly?: boolean }).friendly ? e.message : "The buddy lost connection. Say \"try again\" to retry.";
        setError(msg);
      }
    },
    [pump, stop],
  );

  const retry = useCallback(() => {
    if (lastOpts.current) void start({ ...lastOpts.current, append: false });
  }, [start]);

  useEffect(() => () => { gen.current++; abortRef.current?.abort(); }, []);

  const spokenRaw = batches.join("");
  const unspoken = text.length >= spokenRaw.length ? text.slice(spokenRaw.length) : "";

  return {
    text,
    batches,
    activeBatch,
    unspoken,
    streaming,
    error,
    history,
    label: lastLabel,
    start,
    stop,
    silence,
    retry,
    hasOpts: () => !!lastOpts.current,
  };
}

export type BuddyStream = ReturnType<typeof useBuddyStream>;
