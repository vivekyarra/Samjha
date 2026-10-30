"use client";
import { useCallback, useState } from "react";
import { useVoice, useVoiceScreen } from "@/lib/voice/context";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Spinner } from "@/components/ui/Spinner";
import type { PrefKey, Prefs } from "@/lib/types";

interface PrefRow { id: string; key: PrefKey; value: string; subjectId: string | null; subjectName: string | null; updatedAt: string }

const LABEL: Record<PrefKey, string> = {
  language: "Language", analogy: "Analogies", length: "Length", level: "Level", format: "Format", tone: "Tone", scope: "Scope",
};
const ICON: Record<PrefKey, string> = { language: "🗣", analogy: "🏏", length: "📏", level: "🎓", format: "📋", tone: "😎", scope: "🎯" };
const EXAMPLES = ["Use a cricket analogy", "Explain in Hinglish", "Keep it short from now on", "Like I'm 12", "Exam-level answers", "Step by step", "Strict senior", "Hype coach"];

const display = (r: PrefRow) => (r.key === "analogy" ? `${r.value} analogies` : r.value);

export function StyleClient({ initialPrefs, subjects, defaults }: { initialPrefs: PrefRow[]; subjects: { id: string; name: string }[]; defaults: Prefs }) {
  const { speak } = useVoice();
  const [prefs, setPrefs] = useState<PrefRow[]>(initialPrefs);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [line, setLine] = useState<string>("");
  const [confirmReset, setConfirmReset] = useState(false);

  const say = useCallback((s: string) => {
    setLine(s);
    speak(s);
  }, [speak]);

  const refresh = useCallback(async () => {
    const r = await fetch("/api/prefs", { cache: "no-store" });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Couldn't load your style.");
    setPrefs((await r.json()).prefs);
  }, []);

  const runCommand = useCallback(async (t: string) => {
    setBusy("command");
    setError(null);
    try {
      const r = await fetch("/api/prefs/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: t }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "That didn't work.");
      say(j.suggestion ? `${j.confirmation} ${j.suggestion}` : j.confirmation);
      if (j.applied) await refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
      return false;
    } finally {
      setBusy(null);
    }
  }, [refresh, say]);

  const remove = useCallback(async (p: PrefRow) => {
    setBusy(p.id);
    setError(null);
    try {
      const r = await fetch("/api/prefs", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: p.key, subjectId: p.subjectId }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Couldn't remove that.");
      setPrefs(j.prefs);
      say(p.key === "analogy" ? `Done, no more ${p.value} analogies.` : `Done, ${LABEL[p.key].toLowerCase()} is back to ${defaults[p.key]}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't remove that.");
    } finally {
      setBusy(null);
    }
  }, [defaults, say]);

  const resetAll = useCallback(async () => {
    setBusy("reset");
    setError(null);
    try {
      const r = await fetch("/api/prefs", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ all: true }) });
      if (!r.ok) throw new Error("Couldn't reset your style.");
      setPrefs([]);
      setConfirmReset(false);
      say("Done, your style is back to the defaults.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reset your style.");
    } finally {
      setBusy(null);
    }
  }, [say]);

  useVoiceScreen({
    hint: "Say a style, like \"use cricket analogies\", \"for physics, always formula-first\", or \"stop using cricket\".",
    mode: "browse",
    onInput: async (t, intent) => {
      if (intent.intent === "navigation" || intent.intent === "control") return false;
      if (/^\s*(yes|yeah|haan|ha|sure|ok(ay)?)\b/i.test(t) && /shorter/.test(line)) return runCommand("keep things shorter from now on");
      return runCommand(t);
    },
  });

  const global = prefs.filter((p) => !p.subjectId);
  const bySubject = subjects
    .map((s) => ({ ...s, prefs: prefs.filter((p) => p.subjectId === s.id) }))
    .filter((s) => s.prefs.length);

  const card = (p: PrefRow) => (
    <li key={p.id} className="card flex items-center gap-3 py-3">
      <span aria-hidden className="text-xl">{ICON[p.key]}</span>
      <div className="min-w-0 flex-1">
        <div className="text-xs uppercase tracking-wide text-muted">{LABEL[p.key]}</div>
        <div className="truncate font-medium capitalize">{display(p)}</div>
      </div>
      <button
        type="button"
        className="btn-ghost h-10 w-10 shrink-0 p-0"
        aria-label={`Remove ${LABEL[p.key]}: ${display(p)}`}
        disabled={busy === p.id}
        onClick={() => remove(p)}
      >
        {busy === p.id ? <Spinner label="" size={16} /> : <span aria-hidden>✕</span>}
      </button>
    </li>
  );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="h1">My style</h1>
        <p className="muted">How the buddy talks to you. Change it by voice any time, even mid-explanation. Tap ✕ or say &quot;stop using …&quot; to remove one.</p>
      </header>

      {line && (
        <p role="status" aria-live="polite" className="rounded-xl bg-accent/10 px-4 py-3 text-sm">
          {line}
        </p>
      )}
      {error && <ErrorState title="That didn't work" body={error} retry={() => { setError(null); refresh().catch((e) => setError(String(e.message ?? e))); }} />}

      <section className="flex flex-col gap-3" aria-labelledby="global-h">
        <h2 id="global-h" className="h2">Everywhere</h2>
        {global.length ? (
          <ul className="grid gap-2 sm:grid-cols-2">{global.map(card)}</ul>
        ) : (
          <EmptyState
            title="Using the default style"
            body={`English, short answers, exam-level, chill friend. Say something like "explain in Hinglish with cricket analogies" to make it yours.`}
          />
        )}
      </section>

      {bySubject.map((s) => (
        <section key={s.id} className="flex flex-col gap-3" aria-label={`${s.name} style`}>
          <h2 className="h2">Only in {s.name}</h2>
          <ul className="grid gap-2 sm:grid-cols-2">{s.prefs.map(card)}</ul>
        </section>
      ))}

      <section className="card flex flex-col gap-3" aria-labelledby="add-h">
        <h2 id="add-h" className="h2">Add a preference</h2>
        <p className="muted">Just say it. For one subject, start with its name: &quot;for {subjects[0]?.name ?? "physics"}, always formula-first&quot;.</p>
        {busy === "command" && <Spinner label="Saving" size={16} />}
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" className="btn-ghost px-3 py-1.5 text-xs" disabled={!!busy} onClick={() => runCommand(ex)}>
              {ex}
            </button>
          ))}
        </div>
      </section>

      {prefs.length > 0 && (
        <section className="flex flex-wrap items-center gap-2">
          {confirmReset ? (
            <>
              <span className="muted">Remove every preference?</span>
              <button type="button" className="btn-primary" disabled={busy === "reset"} onClick={resetAll}>Yes, reset</button>
              <button type="button" className="btn-ghost" onClick={() => setConfirmReset(false)}>Keep them</button>
            </>
          ) : (
            <button type="button" className="btn-ghost" onClick={() => setConfirmReset(true)}>Reset my style</button>
          )}
        </section>
      )}
    </div>
  );
}
