"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useVoice, useVoiceScreen } from "@/lib/voice/context";
import type { Persona, VivaHistoryItem, VivaMode, VivaView } from "@/lib/viva/types";
import { DURATIONS, PERSONAS, parsePersona, personaLabel } from "@/lib/viva/types";

interface SubjectOpt { id: string; name: string; claims: number }

const GH_URL = /(https?:\/\/)?(www\.)?github\.com\/[A-Za-z0-9-_.]+\/[A-Za-z0-9-_.]+/i;

function scoreTag(n: number | null) {
  if (n === null) return <span className="muted">In progress</span>;
  const [icon, cls, label] = n >= 70 ? ["✓", "bg-green-soft text-green", "Ready"] : n >= 40 ? ["◐", "bg-amber-soft text-amber", "Getting there"] : ["✗", "bg-red-soft text-red", "Needs work"];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>
      <span aria-hidden>{icon}</span>
      {n}/100 · {label}
    </span>
  );
}

export function VivaSetup({ subjects, history, defaultSubjectId }: { subjects: SubjectOpt[]; history: VivaHistoryItem[]; defaultSubjectId?: string }) {
  const router = useRouter();
  const voice = useVoice();
  const usable = subjects.filter((s) => s.claims > 0);
  const [mode, setMode] = useState<VivaMode>("viva");
  const [subjectId, setSubjectId] = useState(defaultSubjectId && usable.some((s) => s.id === defaultSubjectId) ? defaultSubjectId : usable[0]?.id ?? "");
  const [duration, setDuration] = useState<number>(10);
  const [persona, setPersona] = useState<Persona>("friendly");
  const [repoUrl, setRepoUrl] = useState("");
  const [readme, setReadme] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const subjectName = subjects.find((s) => s.id === subjectId)?.name;
  const canStart = mode === "viva" ? !!subjectId : !!(repoUrl.trim() || readme.trim());

  async function start(over: Partial<{ mode: VivaMode; subjectId: string; duration: number; persona: Persona; repoUrl: string; readme: string }> = {}) {
    const m = over.mode ?? mode;
    const sid = over.subjectId ?? subjectId;
    const url = over.repoUrl ?? repoUrl;
    const rd = over.readme ?? readme;
    if (m === "viva" && !sid) { setError("Pick a subject first."); voice.speak("Pick a subject first."); return; }
    if (m === "placement" && !url.trim() && !rd.trim()) { setError("Paste a GitHub link or your README first."); voice.speak("Paste a GitHub link or your README first."); return; }
    setBusy(true);
    setError(null);
    voice.speak(m === "viva" ? "Preparing your examiner…" : "Reading your project…");
    try {
      const res = await fetch("/api/viva", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: m, subjectId: sid, durationMin: over.duration ?? duration, persona: over.persona ?? persona, repoUrl: url, readme: rd }),
      });
      const j = (await res.json().catch(() => ({}))) as { view?: VivaView; error?: string; pasteReadme?: boolean };
      if (!res.ok || !j.view) {
        if (j.pasteReadme) setShowPaste(true);
        throw new Error(j.error || "Couldn't start. Try again.");
      }
      router.push(`/viva/${j.view.id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't start. Try again.";
      setError(msg);
      voice.speak(msg);
      setBusy(false);
    }
  }

  useVoiceScreen({
    mode: "browse",
    hint: busy
      ? "Setting up your examiner…"
      : mode === "viva"
        ? "Say a subject, “10 minutes”, “strict professor”, then “start”. Or say “placement”."
        : "Paste or say your GitHub link (or README), pick a persona, then say “start”.",
    onInput: (text) => {
      const t = text.toLowerCase().trim();
      const over: Parameters<typeof start>[0] = {};
      const said: string[] = [];
      const url = text.match(GH_URL)?.[0];
      if (url) { over.mode = "placement"; over.repoUrl = url; said.push("Got your repository"); }
      else if (/\b(placement|project|interview|github|repo|resume)\b/.test(t) && t.split(/\s+/).length <= 12) { over.mode = "placement"; said.push("Placement mode"); }
      else if (/\b(viva|oral|exam)\b/.test(t) && t.split(/\s+/).length <= 12) { over.mode = "viva"; said.push("Viva mode"); }
      const min = t.match(/\b(5|10|15|five|ten|fifteen)\b\s*(min|minute)/);
      if (min) {
        const n = ({ five: 5, ten: 10, fifteen: 15 } as Record<string, number>)[min[1]] ?? Number(min[1]);
        over.duration = n; said.push(`${n} minutes`);
      }
      const p = t.split(/\s+/).length <= 14 ? parsePersona(t) : null;
      if (p) { over.persona = p; said.push(personaLabel(p)); }
      if (!url && t.split(/\s+/).length <= 12) {
        const subj = usable.find((s) => t.includes(s.name.toLowerCase())) ?? usable.find((s) => s.name.toLowerCase().split(/\s+/).some((w) => w.length > 3 && t.includes(w)));
        if (subj) { over.subjectId = subj.id; over.mode = over.mode ?? "viva"; said.push(subj.name); }
      }
      const effMode = over.mode ?? mode;
      if (!url && effMode === "placement" && t.split(/\s+/).length > 25) {
        over.readme = text; said.push("Got your project description"); setShowPaste(true);
      }
      const wantsStart = /\b(start|begin|go|let'?s go|ready|shuru)\b/.test(t) && t.split(/\s+/).length <= 14;

      if (over.mode) setMode(over.mode);
      if (over.repoUrl) setRepoUrl(over.repoUrl);
      if (over.readme) setReadme(over.readme);
      if (over.duration) setDuration(over.duration);
      if (over.persona) setPersona(over.persona);
      if (over.subjectId) setSubjectId(over.subjectId);

      if (wantsStart && !busy) { void start(over); return true; }
      if (said.length) { voice.speak(`${said.join(", ")}. Say start when ready.`); return true; }
      return false;
    },
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="h1">Viva &amp; placement practice</h1>
        <p className="muted mt-1">An examiner asks out loud, adapts to your answers and gives you a scorecard. Answer entirely by voice.</p>
      </header>

      <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="Mode">
        {(["viva", "placement"] as const).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} className={`card text-left transition ${mode === m ? "ring-2 ring-accent" : "hover:bg-surface-2"}`} onClick={() => setMode(m)}>
            <p className="font-semibold">{m === "viva" ? "🎓 Viva" : "💼 Placement"}</p>
            <p className="muted">{m === "viva" ? "Oral exam from your notes" : "Grilled on your own project"}</p>
          </button>
        ))}
      </div>

      <section className="card space-y-4">
        {mode === "viva" ? (
          usable.length === 0 ? (
            <div className="text-center">
              <p className="font-medium">No subjects with notes yet</p>
              <p className="muted mt-1">Upload your notes first so the examiner has something to ask from.</p>
              <Link href="/subjects/new" className="btn-primary mt-3">Upload notes</Link>
            </div>
          ) : (
            <>
              <div>
                <label htmlFor="subject" className="text-sm font-medium">Subject</label>
                <select id="subject" className="input mt-1" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
                  {usable.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.claims} claims)</option>)}
                </select>
              </div>
            </>
          )
        ) : (
          <>
            <div>
              <label htmlFor="repo" className="text-sm font-medium">GitHub repository</label>
              <input id="repo" className="input mt-1" inputMode="url" placeholder="github.com/you/your-project" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} />
            </div>
            {showPaste || readme ? (
              <div>
                <label htmlFor="readme" className="text-sm font-medium">README or project description</label>
                <textarea id="readme" className="input mt-1 min-h-32" placeholder="Paste your README, or describe what it does, the stack and how it's built." value={readme} onChange={(e) => setReadme(e.target.value)} />
              </div>
            ) : (
              <button className="text-sm text-accent underline" onClick={() => setShowPaste(true)}>Private repo? Paste the README instead</button>
            )}
          </>
        )}

        <fieldset>
          <legend className="text-sm font-medium">Duration</legend>
          <div className="mt-1 flex gap-2">
            {DURATIONS.map((d) => (
              <button key={d} className={duration === d ? "btn-primary" : "btn-ghost"} aria-pressed={duration === d} onClick={() => setDuration(d)}>{d} min</button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-sm font-medium">Examiner</legend>
          <div className="mt-1 grid gap-2 sm:grid-cols-3">
            {PERSONAS.map((p) => (
              <button key={p.id} aria-pressed={persona === p.id} className={`rounded-xl border p-3 text-left text-sm transition ${persona === p.id ? "border-accent bg-surface-2" : "border-line hover:bg-surface-2"}`} onClick={() => setPersona(p.id)}>
                <p className="font-medium">{p.label}</p>
                <p className="muted text-xs">{p.blurb}</p>
              </button>
            ))}
          </div>
        </fieldset>

        {error && <p className="rounded-xl bg-red-soft p-3 text-sm text-red" role="alert"><span aria-hidden>✗ </span>{error}</p>}

        <button className="btn-primary w-full py-3 text-base" disabled={busy || !canStart} onClick={() => void start()}>
          {busy ? "Preparing questions…" : mode === "viva" ? `Start ${duration}-minute viva${subjectName ? ` on ${subjectName}` : ""}` : `Start ${duration}-minute placement interview`}
        </button>
      </section>

      <section>
        <h2 className="h2">Past sessions</h2>
        {history.length === 0 ? (
          <p className="muted card mt-2">No vivas yet. Your scorecards will show up here.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {history.map((h) => (
              <li key={h.id}>
                <Link href={`/viva/${h.id}`} className="card flex items-center justify-between gap-3 hover:bg-surface-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{h.title}</p>
                    <p className="muted">{personaLabel(h.persona)} · {new Date(h.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</p>
                  </div>
                  {scoreTag(h.overall)}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
