"use client";
// Samjha voice contract. The VoiceBox (always mounted in the app shell) owns input + TTS.
// Screens register a handler with useVoiceScreen(); the VoiceBox classifies each submission and:
//   - handles "navigation" and "control" globally (unless the screen handler returns true for them first),
//   - passes everything else to the active screen handler.
import { createContext, useContext, useEffect, useLayoutEffect, useRef } from "react";
import type { IntentResult } from "@/lib/types";

export interface VoiceScreen {
  /** Short hint shown above the Voice Box, e.g. "Explaining Backpropagation… say done when finished". */
  hint: string;
  /** Screen state used by the classifier (spec §5.2 rule 2). "explain" makes long utterances default to explanation. */
  mode: "explain" | "buddy" | "browse" | "viva" | "exam_eve" | "onboarding" | "review";
  /** Extra context for classification and navigation (current subject/topic). */
  subjectId?: string;
  topicId?: string;
  /** Called with the raw text and its classified intent. Return true if handled (stops global handling). */
  onInput: (text: string, intent: IntentResult) => boolean | void | Promise<boolean | void>;
}

export interface SpeakOptions { lang?: string; onSentence?: (index: number) => void; onEnd?: () => void }

export interface VoiceApi {
  /** Speak text aloud (Web Speech, or premium TTS if enabled). Stops anything currently playing. */
  speak: (text: string, opts?: SpeakOptions) => void;
  /** Stop all speech immediately. */
  stop: () => void;
  /** True while speaking. */
  speaking: boolean;
  /** Index of the sentence currently being read (for highlighting), -1 if none. */
  sentenceIndex: number;
  /** Split text into the same sentences the speaker uses (for highlighting). */
  sentences: (text: string) => string[];
  /** Put text into the Voice Box (e.g. "suggested explanation" button) and optionally submit it. */
  setInput: (text: string, submit?: boolean) => void;
  /** Programmatically submit text as if spoken. */
  submit: (text: string) => void;
  /** Register the active screen. Use the useVoiceScreen hook instead of calling directly. */
  register: (s: VoiceScreen | null) => void;
}

export const VoiceContext = createContext<VoiceApi | null>(null);

export function useVoice(): VoiceApi {
  const v = useContext(VoiceContext);
  if (!v) throw new Error("useVoice must be used inside <VoiceProvider>");
  return v;
}

/** Register this screen's voice handler while mounted. Always uses the latest closure. */
export function useVoiceScreen(screen: VoiceScreen) {
  const v = useVoice();
  const ref = useRef(screen);
  // Refresh after every commit; layout effects run before the passive effects below and before
  // any timer or input event can reach onInput, so callers always see the latest closure.
  useLayoutEffect(() => {
    ref.current = screen;
  });
  useEffect(() => {
    v.register({
      get hint() { return ref.current.hint; },
      get mode() { return ref.current.mode; },
      get subjectId() { return ref.current.subjectId; },
      get topicId() { return ref.current.topicId; },
      onInput: (t, i) => ref.current.onInput(t, i),
    });
    return () => v.register(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // re-register when hint/mode change so the VoiceBox re-renders the hint
  useEffect(() => {
    v.register({
      get hint() { return ref.current.hint; },
      get mode() { return ref.current.mode; },
      get subjectId() { return ref.current.subjectId; },
      get topicId() { return ref.current.topicId; },
      onInput: (t, i) => ref.current.onInput(t, i),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen.hint, screen.mode, screen.subjectId, screen.topicId]);
}
