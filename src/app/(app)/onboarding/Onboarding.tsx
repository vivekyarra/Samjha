"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useVoice, useVoiceScreen } from "@/lib/voice/context";
import { Spinner } from "@/components/ui";

type Language = "English" | "Hinglish" | "Hindi";
const LANGUAGES: { value: Language; blurb: string }[] = [
  { value: "English", blurb: "Plain, simple English" },
  { value: "Hinglish", blurb: "Mix of Hindi and English, like you talk with friends" },
  { value: "Hindi", blurb: "पूरी बात हिंदी में" },
];
const ANALOGIES = ["cricket", "football", "movies", "gaming", "cooking", "anime", "music"];
const TONES = ["chill friend", "strict senior", "hype coach"];
const STEP_TITLES = ["Language", "Style", "Your notes", "First explanation"];
const PROMPTS = [
  "Which language should I explain things in? English, Hinglish or Hindi?",
  "How should I explain? Say something like cricket analogies, or chill friend. Or say skip.",
  "Upload your first notes, or say use sample notes to try with a machine learning course.",
  "Ready? Say start, and explain the topic like you're teaching a junior.",
];

const HEADINGS = ["Which language should I explain in?", "How should your buddy explain?", "Add your first notes", "Your first explanation"];

const isSkip = (t: string) => /\b(skip|next|continue|done|aage|chalo|later|baad mein)\b/i.test(t);

async function savePref(key: string, value: string) {
  try {
    await fetch("/api/prefs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, value }) });
  } catch {
    /* preference saving is best-effort during onboarding */
  }
}

export function Onboarding({ name, initialLanguage, initialStep }: { name: string; initialLanguage: string; initialStep: number }) {
  const router = useRouter();
  const voice = useVoice();
  const [step, setStep] = useState(initialStep);
  const [language, setLanguage] = useState<Language>((["English", "Hinglish", "Hindi"].includes(initialLanguage) ? initialLanguage : "English") as Language);
  const [analogy, setAnalogy] = useState("");
  const [tone, setTone] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [topic, setTopic] = useState<{ id: string; name: string } | null>(null);
  const [topicChecked, setTopicChecked] = useState(false);
  const loadingTopic = step === 3 && !topic && !topicChecked;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const interacted = useRef(false);

  // Speak each step's question once the user has interacted (browsers block speech before that).
  useEffect(() => {
    if (interacted.current) voice.speak(PROMPTS[step]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Step 4 without sample notes: find the topic to start with (e.g. after uploading on /subjects/new).
  useEffect(() => {
    if (step !== 3 || topic || topicChecked) return;
    let alive = true;
    fetch("/api/study/next")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { topicId?: string | null; name?: string | null } | null) => {
        if (alive && d?.topicId) setTopic({ id: d.topicId, name: d.name ?? "your first topic" });
      })
      .catch(() => {})
      .finally(() => alive && setTopicChecked(true));
    return () => {
      alive = false;
    };
  }, [step, topic, topicChecked]);

  const go = (n: number) => {
    interacted.current = true;
    setError(null);
    setNote(null);
    setStep(n);
  };

  function chooseLanguage(l: Language) {
    setLanguage(l);
    void savePref("language", l);
    go(1);
  }

  function chooseAnalogy(a: string) {
    const v = analogy === a ? "" : a;
    setAnalogy(v);
    void savePref("analogy", v);
    setNote(v ? `Got it, ${v} analogies from now on.` : "Okay, I'll pick analogies myself.");
  }

  function chooseTone(t: string) {
    setTone(t);
    void savePref("tone", t);
    setNote(`Got it, ${t} it is.`);
  }

  async function loadSample() {
    interacted.current = true;
    setBusy("sample");
    setError(null);
    try {
      const res = await fetch("/api/demo/sample", { method: "POST" });
      const d = (await res.json()) as { topicId?: string; topicName?: string; error?: string };
      if (!res.ok || !d.topicId) throw new Error(d.error || "Couldn't load the sample notes.");
      setTopic({ id: d.topicId, name: d.topicName ?? "Gradient Descent" });
      go(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the sample notes.");
    } finally {
      setBusy(null);
    }
  }

  async function finish(target: "session" | "home") {
    setBusy(target);
    setError(null);
    try {
      const res = await fetch("/api/auth/onboarded", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language }),
      });
      if (!res.ok) throw new Error("Couldn't save. Try again.");
      router.push(target === "session" && topic ? `/session/${topic.id}` : "/home");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save. Try again.");
      setBusy(null);
    }
  }

  async function styleByVoice(text: string): Promise<boolean> {
    const t = text.toLowerCase();
    let matched = false;
    const a = ANALOGIES.find((x) => t.includes(x)) ?? t.match(/(\w+)\s+analog/)?.[1];
    if (a && !/^(no|any|an|some)$/.test(a)) {
      setAnalogy(a);
      void savePref("analogy", a);
      matched = true;
    }
    const tn = TONES.find((x) => t.includes(x.split(" ")[0]));
    if (tn) {
      setTone(tn);
      void savePref("tone", tn);
      matched = true;
    }
    if (matched) {
      const msg = `Got it${a ? `, ${a} analogies` : ""}${tn ? `${a ? " and" : ","} ${tn} tone` : ""} from now on.`;
      setNote(msg);
      voice.speak(msg);
      return true;
    }
    try {
      const res = await fetch("/api/prefs/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      const d = (await res.json()) as { applied?: unknown; confirmation?: string };
      if (res.ok && d.applied && d.confirmation) {
        setNote(d.confirmation);
        voice.speak(d.confirmation);
        return true;
      }
    } catch {
      /* fall through */
    }
    return false;
  }

  useVoiceScreen({
    mode: "onboarding",
    hint: [
      "Say English, Hinglish or Hindi",
      "Say a style like “cricket analogies” or “chill friend”, then “next”, or “skip”",
      "Say “use sample notes”, “upload”, or “skip”",
      topic ? `Say “start” to explain ${topic.name}` : "Say “sample notes” or “upload”",
    ][step],
    onInput: async (text) => {
      interacted.current = true;
      const t = text.toLowerCase();
      if (step === 0) {
        const l: Language | null = /hinglish/.test(t) ? "Hinglish" : /hindi|हिंदी|हिन्दी/.test(t) ? "Hindi" : /english/.test(t) ? "English" : null;
        if (l) chooseLanguage(l);
        else if (isSkip(t)) go(1);
        else return false;
        return true;
      }
      if (step === 1) {
        if (isSkip(t) && t.split(/\s+/).length <= 3) {
          go(2);
          return true;
        }
        return styleByVoice(text);
      }
      if (step === 2) {
        if (/sample|example|demo/.test(t)) void loadSample();
        else if (/upload|my notes|add notes|pdf/.test(t)) router.push("/subjects/new?onboarding=1");
        else if (isSkip(t)) go(3);
        else return false;
        return true;
      }
      if (topic && /\b(start|go|ready|let'?s|chalo|explain)\b/.test(t)) void finish("session");
      else if (/sample/.test(t)) void loadSample();
      else if (/upload/.test(t)) router.push("/subjects/new?onboarding=1");
      else if (isSkip(t) || /home|heatmap/.test(t)) void finish("home");
      else return false;
      return true;
    },
  });

  return (
    <div className="mx-auto max-w-xl py-4">
      <p className="muted">Hi {name.split(" ")[0]}, let&apos;s set things up. Talk or tap, whatever&apos;s easier.</p>

      <ol className="mt-4 flex gap-2" aria-label="Onboarding progress">
        {STEP_TITLES.map((s, i) => (
          <li key={s} className="flex-1">
            <div className={`h-1.5 rounded-full ${i <= step ? "bg-accent" : "bg-line"}`} />
            <span className={`mt-1 block text-xs ${i === step ? "font-medium text-fg" : "text-muted"}`}>
              <span className="sr-only">{i < step ? "Done: " : i === step ? "Current: " : ""}</span>
              {s}
            </span>
          </li>
        ))}
      </ol>

      <section className="card mt-6" aria-live="polite">
        <h1 className="h1">{HEADINGS[step]}</h1>

        {step === 0 && (
          <div className="mt-5 grid gap-3">
            {LANGUAGES.map((l) => (
              <button
                key={l.value}
                onClick={() => chooseLanguage(l.value)}
                className={`rounded-xl border px-4 py-3 text-left transition hover:bg-surface-2 ${language === l.value ? "border-accent" : "border-line"}`}
              >
                <span className="block font-semibold">{l.value}</span>
                <span className="text-sm text-muted">{l.blurb}</span>
              </button>
            ))}
          </div>
        )}

        {step === 1 && (
          <div className="mt-5 space-y-5">
            <div>
              <p className="mb-2 text-sm font-medium">Analogies from</p>
              <div className="flex flex-wrap gap-2">
                {ANALOGIES.map((a) => (
                  <button key={a} onClick={() => chooseAnalogy(a)} aria-pressed={analogy === a}
                    className={`rounded-full border px-3 py-1.5 text-sm capitalize ${analogy === a ? "border-accent bg-accent text-accent-fg" : "border-line hover:bg-surface-2"}`}>
                    {analogy === a ? "✓ " : ""}{a}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">Tone</p>
              <div className="flex flex-wrap gap-2">
                {TONES.map((t) => (
                  <button key={t} onClick={() => chooseTone(t)} aria-pressed={tone === t}
                    className={`rounded-full border px-3 py-1.5 text-sm capitalize ${tone === t ? "border-accent bg-accent text-accent-fg" : "border-line hover:bg-surface-2"}`}>
                    {tone === t ? "✓ " : ""}{t}
                  </button>
                ))}
              </div>
            </div>
            <p className="muted">You can change this any time by just saying it: &ldquo;explain like I&apos;m 12&rdquo;, &ldquo;shorter&rdquo;, &ldquo;stop using cricket&rdquo;.</p>
            <div className="flex gap-3">
              <button className="btn-primary flex-1" onClick={() => go(2)}>Continue</button>
              <button className="btn-ghost" onClick={() => go(2)}>Skip</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="mt-5 grid gap-3">
            <button className="rounded-xl border border-line px-4 py-3 text-left hover:bg-surface-2" onClick={() => router.push("/subjects/new?onboarding=1")} disabled={!!busy}>
              <span className="block font-semibold">Upload my notes</span>
              <span className="text-sm text-muted">PDF, slides, a photo of handwritten notes, or paste text</span>
            </button>
            <button className="rounded-xl border border-line px-4 py-3 text-left hover:bg-surface-2" onClick={loadSample} disabled={!!busy}>
              <span className="block font-semibold">{busy === "sample" ? <Spinner label="Loading sample notes…" /> : "Use sample notes"}</span>
              <span className="text-sm text-muted">Intro to Machine Learning, 10 pages, ready in a second</span>
            </button>
            <button className="btn-ghost justify-self-start" onClick={() => go(3)} disabled={!!busy}>Skip for now</button>
          </div>
        )}

        {step === 3 && (
          <div className="mt-5 space-y-4">
            {loadingTopic ? (
              <Spinner label="Finding your first topic…" />
            ) : topic ? (
              <>
                <p className="text-lg">
                  Explain <span className="font-semibold">{topic.name}</span> like you&apos;re teaching a junior. Take your time,
                  then pause or say &ldquo;done&rdquo;. Samjha will find exactly what you missed.
                </p>
                <button className="btn-primary w-full py-3 text-base" onClick={() => finish("session")} disabled={!!busy}>
                  {busy === "session" ? "Starting…" : `Start explaining ${topic.name}`}
                </button>
              </>
            ) : (
              <>
                <p className="text-muted">You don&apos;t have any notes yet. Add some, or try the sample course first.</p>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <button className="btn-primary flex-1" onClick={loadSample} disabled={!!busy}>
                    {busy === "sample" ? "Loading…" : "Use sample notes"}
                  </button>
                  <button className="btn-ghost flex-1" onClick={() => router.push("/subjects/new?onboarding=1")}>Upload notes</button>
                </div>
              </>
            )}
            <button className="text-sm text-muted underline-offset-2 hover:underline" onClick={() => finish("home")} disabled={!!busy}>
              Skip to my heatmap
            </button>
          </div>
        )}

        {note && <p role="status" className="mt-4 rounded-xl bg-green-soft px-3 py-2 text-sm text-green">✓ {note}</p>}
        {error && <p role="alert" className="mt-4 rounded-xl border border-red/40 bg-red-soft px-3 py-2 text-sm text-red">{error}</p>}
      </section>

      {step > 0 && (
        <button className="mt-4 text-sm text-muted hover:text-fg" onClick={() => go(step - 1)}>
          ← Back
        </button>
      )}
    </div>
  );
}
