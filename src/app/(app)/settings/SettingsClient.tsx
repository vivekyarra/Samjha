"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVoice, useVoiceScreen } from "@/lib/voice/context";
import { deepMerge, type Settings } from "@/lib/settings/schema";
import { applyTheme } from "@/components/settings/ThemeApplier";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
interface SubjectLite { id: string; name: string; examDate: string | null }
interface NudgeLite { id: string; channel: string; kind: string | null; body: string | null; status: string | null; sent_at: string | null; opened_at: string | null }
type SaveState = "idle" | "saving" | "saved" | "error";

const FREQ_LABEL: Record<Settings["nudges"]["frequency"], string> = { daily: "Daily", every2days: "Every 2 days", weekly: "Weekly", off: "Off" };
const STATUS_LABEL: Record<string, string> = { sent: "Sent", in_app: "Delivered in app", failed: "Couldn't send", pending: "Sending" };
const CHANNEL_LABEL: Record<string, string> = { email: "Email", whatsapp: "WhatsApp", in_app: "In app" };

function toSubjects(v: unknown): SubjectLite[] {
  const arr = Array.isArray(v) ? v : v && typeof v === "object" ? ((v as { subjects?: unknown }).subjects ?? []) : [];
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object" && typeof (s as { id?: unknown }).id === "string")
    .map((s) => ({
      id: String(s.id),
      name: String(s.name ?? "Untitled"),
      examDate: typeof (s.exam_date ?? s.examDate) === "string" ? String(s.exam_date ?? s.examDate).slice(0, 10) : null,
    }));
}

function download(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function SettingsClient({ initial, user }: { initial: Settings; user: { name: string; email: string | null; isDemo: boolean } }) {
  const voice = useVoice();
  const [settings, setSettings] = useState<Settings>(initial);
  const [save, setSave] = useState<{ state: SaveState; error?: string }>({ state: "idle" });
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Kept in step with `settings` by `update`, the only writer of settings state.
  const latest = useRef(settings);

  const [subjects, setSubjects] = useState<SubjectLite[] | null>(null);
  const [subjectsError, setSubjectsError] = useState<string | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [nudges, setNudges] = useState<{ list: NudgeLite[]; next?: { reason: string; shouldSend: boolean } | null; live?: { email: boolean; whatsapp: boolean } } | null>(null);
  const [nudgeMsg, setNudgeMsg] = useState<string | null>(null);
  const [name, setName] = useState(user.name);
  const [nameState, setNameState] = useState<SaveState>("idle");
  const [token, setToken] = useState<{ value?: string; error?: string; loading?: boolean; copied?: boolean }>({});
  const [examSaving, setExamSaving] = useState<Record<string, SaveState>>({});

  const persist = useCallback(async () => {
    setSave({ state: "saving" });
    try {
      const res = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(latest.current) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't save");
      setSave({ state: "saved" });
      try {
        localStorage.setItem("samjha.settings", JSON.stringify(data));
      } catch {}
      window.dispatchEvent(new CustomEvent("samjha:settings", { detail: data }));
    } catch (e) {
      setSave({ state: "error", error: e instanceof Error ? e.message : "Couldn't save" });
    }
  }, []);

  const update = useCallback(
    (patch: DeepPartial<Settings> | { voiceName: string | null }) => {
      const next = deepMerge(latest.current, patch);
      latest.current = next;
      setSettings(next);
      if ("theme" in patch && patch.theme) applyTheme(patch.theme);
      if (pending.current) clearTimeout(pending.current);
      pending.current = setTimeout(persist, 450);
    },
    [persist],
  );

  // Timezone auto-detect on first visit.
  useEffect(() => {
    if (!initial.nudges.timezone) {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) update({ nudges: { timezone: tz } });
    }
  }, [initial.nudges.timezone, update]);

  useEffect(() => () => {
    if (pending.current) {
      clearTimeout(pending.current);
      void persist();
    }
  }, [persist]);

  // State updates happen only in the promise callbacks, after the request settles.
  const fetchSubjects = useCallback(
    (): Promise<void> =>
      fetch("/api/subjects")
        .then((r) => {
          if (!r.ok) throw new Error();
          return r.json();
        })
        .then((data) => setSubjects(toSubjects(data)))
        .catch(() => {
          setSubjectsError("Couldn't load your subjects.");
          setSubjects([]);
        }),
    [],
  );

  const loadSubjects = useCallback(() => {
    setSubjectsError(null);
    return fetchSubjects();
  }, [fetchSubjects]);

  const loadNudges = useCallback(
    (): Promise<void> =>
      fetch("/api/nudges")
        .then((r) => {
          if (!r.ok) throw new Error();
          return r.json();
        })
        .then((d) => setNudges({ list: d.nudges ?? [], next: d.next, live: d.live }))
        .catch(() => setNudges({ list: [] })),
    [],
  );

  useEffect(() => {
    // subjectsError starts null, so the first load skips the reset that "Try again" does.
    void fetchSubjects();
    void loadNudges();
  }, [fetchSubjects, loadNudges]);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  const sortedVoices = useMemo(
    () => [...voices].sort((a, b) => Number(/^(en|hi)/i.test(b.lang)) - Number(/^(en|hi)/i.test(a.lang)) || a.name.localeCompare(b.name)),
    [voices],
  );
  const timezones = useMemo(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return [] as string[];
    }
  }, []);

  const previewVoice = () => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance("Hi! This is how I'll sound when I explain your gaps.");
    u.rate = settings.voiceRate;
    const v = voices.find((x) => x.name === settings.voiceName);
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
    window.speechSynthesis.speak(u);
  };

  const sendTest = async () => {
    setNudgeMsg("Sending…");
    try {
      if (pending.current) {
        clearTimeout(pending.current);
        pending.current = null;
        await persist();
      }
      const r = await fetch("/api/nudges/test", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Couldn't send");
      const chans = (d.nudges ?? []).map((n: NudgeLite) => `${CHANNEL_LABEL[n.channel] ?? n.channel}: ${STATUS_LABEL[n.status ?? ""] ?? n.status}`).join(", ");
      setNudgeMsg(`“${d.body}” · ${chans}`);
      void loadNudges();
      return d.body as string;
    } catch (e) {
      setNudgeMsg(e instanceof Error ? e.message : "Couldn't send");
      return null;
    }
  };

  const saveExam = async (id: string, examDate: string) => {
    setExamSaving((s) => ({ ...s, [id]: "saving" }));
    try {
      const r = await fetch(`/api/subjects/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ examDate: examDate || null }),
      });
      if (!r.ok) throw new Error();
      setSubjects((list) => list?.map((s) => (s.id === id ? { ...s, examDate: examDate || null } : s)) ?? null);
      setExamSaving((s) => ({ ...s, [id]: "saved" }));
      void loadNudges();
    } catch {
      setExamSaving((s) => ({ ...s, [id]: "error" }));
    }
  };

  const saveName = async () => {
    if (!name.trim() || name.trim() === user.name) return;
    setNameState("saving");
    try {
      const r = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      setNameState(r.ok ? "saved" : "error");
    } catch {
      setNameState("error");
    }
  };

  const signOut = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/";
    }
  };

  const loadToken = async () => {
    setToken({ loading: true });
    try {
      const r = await fetch("/api/ext/token");
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Couldn't get a token");
      const value = typeof d === "string" ? d : d.token ?? d.value;
      if (!value) throw new Error("Couldn't get a token");
      setToken({ value: String(value) });
    } catch (e) {
      setToken({ error: e instanceof Error ? e.message : "Couldn't get a token" });
    }
  };
  const copyToken = async () => {
    if (!token.value) return;
    try {
      await navigator.clipboard.writeText(token.value);
      setToken((t) => ({ ...t, copied: true }));
      setTimeout(() => setToken((t) => ({ ...t, copied: false })), 2000);
    } catch {
      setToken((t) => ({ ...t, error: "Copy failed. Select the token and copy it manually." }));
    }
  };

  const pickSubject = (text: string): SubjectLite | null => {
    if (!subjects?.length) return null;
    const t = text.toLowerCase();
    return subjects.find((s) => t.includes(s.name.toLowerCase())) ?? subjects[0];
  };

  useVoiceScreen({
    hint: "Settings… say “slower voice”, “turn off nudges”, “dark mode” or “export Anki”",
    mode: "browse",
    onInput: async (raw, intent) => {
      const t = raw.toLowerCase().trim();
      const say = (s: string) => voice.speak(s);
      const action = intent.intent === "control" ? String(intent.args.action ?? "") : "";
      if (/\bslower\b/.test(t) || action === "slower") {
        const r = Math.max(0.5, Math.round((settings.voiceRate - 0.1) * 10) / 10);
        update({ voiceRate: r });
        say(`Okay, voice speed ${r}.`);
        return true;
      }
      if (/\bfaster\b/.test(t) || action === "faster") {
        const r = Math.min(2, Math.round((settings.voiceRate + 0.1) * 10) / 10);
        update({ voiceRate: r });
        say(`Okay, voice speed ${r}.`);
        return true;
      }
      if (/(turn|switch|shut)\s*off\s*(the\s*)?(nudges|reminders)|(stop|no more|pause)\s*(the\s*)?(nudges|reminders)|unsubscribe/.test(t)) {
        update({ nudges: { frequency: "off" } });
        say("Nudges are off. Turn them back on any time.");
        return true;
      }
      if (/(turn|switch)\s*on\s*(the\s*)?(nudges|reminders)|(nudges|reminders)\s*on\b/.test(t)) {
        update({ nudges: { frequency: settings.nudges.frequency === "off" ? "daily" : settings.nudges.frequency } });
        say("Nudges are on.");
        return true;
      }
      const freq = /\b(daily|every day|every (two|2) days|weekly|once a week)\b/.exec(t);
      if (freq && /nudge|remind/.test(t)) {
        const f = freq[1].startsWith("week") || freq[1] === "once a week" ? "weekly" : freq[1].includes("2") || freq[1].includes("two") ? "every2days" : "daily";
        update({ nudges: { frequency: f } });
        say(`Nudges set to ${FREQ_LABEL[f].toLowerCase()}.`);
        return true;
      }
      if (/\bdark\s*(mode|theme)?\b/.test(t) && !/light/.test(t)) {
        update({ theme: "dark" });
        say("Dark mode on.");
        return true;
      }
      if (/\blight\s*(mode|theme)\b/.test(t)) {
        update({ theme: "light" });
        say("Light mode on.");
        return true;
      }
      if (/(system|auto(matic)?)\s*(mode|theme)/.test(t)) {
        update({ theme: "system" });
        say("Theme follows your device now.");
        return true;
      }
      if (/\banki\b/.test(t)) {
        const s = pickSubject(t);
        if (!s) {
          say("Add a subject first, then I can export it to Anki.");
          return true;
        }
        download(`/api/export/anki?subjectId=${encodeURIComponent(s.id)}`);
        say(`Exporting ${s.name} to Anki.`);
        return true;
      }
      if (/(gaps|revision sheet|gap sheet)/.test(t) && /export|download|pdf|sheet|print/.test(t)) {
        const s = pickSubject(t);
        download(s ? `/api/export/gaps.pdf?subjectId=${encodeURIComponent(s.id)}` : "/api/export/gaps.pdf");
        say(`Downloading your gaps-only sheet${s ? ` for ${s.name}` : ""}.`);
        return true;
      }
      if (/test nudge|send me a nudge|nudge me( now)?/.test(t)) {
        const body = await sendTest();
        say(body ? `Sent: ${body}` : "I couldn't send that nudge.");
        return true;
      }
      if (/say send|only when i say send/.test(t)) {
        update({ submitMode: "say_send" });
        say("Okay, I'll wait until you say send.");
        return true;
      }
      if (/auto.?submit|submit on pause|pause mode/.test(t)) {
        update({ submitMode: "pause" });
        say("Okay, I'll submit when you pause.");
        return true;
      }
      const pause = /pause\D{0,20}(\d(?:\.\d)?)\s*(s|sec|seconds?)\b/.exec(t);
      if (pause) {
        const ms = Math.round(Math.min(4, Math.max(0.8, parseFloat(pause[1]))) * 10) * 100;
        update({ autoSubmitMs: ms });
        say(`Auto-submit after ${ms / 1000} seconds.`);
        return true;
      }
      if (/premium voice/.test(t)) {
        const on = !/\boff\b|disable|turn off/.test(t);
        update({ premiumVoice: on });
        say(`Premium voice ${on ? "on" : "off"}.`);
        return true;
      }
      if (/sign out|log ?out/.test(t)) {
        void signOut();
        return true;
      }
      return false;
    },
  });

  const n = settings.nudges;
  const saveLabel = save.state === "saving" ? "Saving…" : save.state === "saved" ? "Saved" : save.state === "error" ? save.error : "";

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="h1">Settings</h1>
        <span role="status" aria-live="polite" className={`text-sm ${save.state === "error" ? "text-red" : "text-muted"}`}>
          {saveLabel}
          {save.state === "error" && (
            <button className="ml-2 underline" onClick={() => void persist()}>Retry</button>
          )}
        </span>
      </div>

      <Section title="Voice" hint="Say “slower voice” or “faster voice”.">
        <Field label={`Speaking speed · ${settings.voiceRate.toFixed(1)}×`}>
          <input type="range" min={0.5} max={2} step={0.1} value={settings.voiceRate} onChange={(e) => update({ voiceRate: Number(e.target.value) })} className="w-full accent-[var(--accent)]" aria-label="Speaking speed" />
        </Field>
        <Field label="Voice">
          <div className="flex gap-2">
            <select className="input" value={settings.voiceName ?? ""} onChange={(e) => update({ voiceName: e.target.value || null })}>
              <option value="">Automatic (matches your language)</option>
              {sortedVoices.map((v) => (
                <option key={v.voiceURI} value={v.name}>{v.name} · {v.lang}</option>
              ))}
            </select>
            <button className="btn-ghost shrink-0" onClick={previewVoice}>Try</button>
          </div>
          {voices.length === 0 && <p className="muted mt-1">Your browser hasn&apos;t listed its voices yet. The default voice will be used.</p>}
        </Field>
        <Toggle label="Premium voice" detail="More natural voice when the server has one configured." checked={settings.premiumVoice} onChange={(v) => update({ premiumVoice: v })} />
      </Section>

      <Section title="Voice Box" hint="How your spoken explanation gets submitted.">
        <Segmented
          label="Submit"
          value={settings.submitMode}
          options={[{ value: "pause", label: "When I pause" }, { value: "say_send", label: "When I say “send”" }]}
          onChange={(v) => update({ submitMode: v })}
        />
        {settings.submitMode === "pause" && (
          <Field label={`Pause before auto-submit · ${(settings.autoSubmitMs / 1000).toFixed(1)}s`}>
            <input type="range" min={800} max={4000} step={100} value={settings.autoSubmitMs} onChange={(e) => update({ autoSubmitMs: Number(e.target.value) })} className="w-full accent-[var(--accent)]" aria-label="Auto-submit pause" />
          </Field>
        )}
      </Section>

      <Section title="Appearance" hint="Say “dark mode” or “light mode”.">
        <Segmented
          label="Theme"
          value={settings.theme}
          options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
          onChange={(v) => update({ theme: v })}
        />
      </Section>

      <Section title="Nudges" hint="A short reminder when concepts are due. Say “turn off nudges”.">
        <Segmented
          label="How often"
          value={n.frequency}
          options={(["daily", "every2days", "weekly", "off"] as const).map((f) => ({ value: f, label: FREQ_LABEL[f] }))}
          onChange={(v) => update({ nudges: { frequency: v } })}
        />
        <div className={n.frequency === "off" ? "pointer-events-none opacity-50" : ""} aria-disabled={n.frequency === "off"}>
          <Toggle label="Email" detail={user.email ?? "No email on this account"} checked={n.email && !!user.email} disabled={!user.email} onChange={(v) => update({ nudges: { email: v } })} />
          <Toggle label="WhatsApp" detail="Needs your phone number with country code." checked={n.whatsapp} onChange={(v) => update({ nudges: { whatsapp: v } })} />
          {n.whatsapp && (
            <Field label="WhatsApp number, with country code (like +91 98765 43210)">
              <input className="input" type="tel" inputMode="tel" autoComplete="tel" value={n.phone ?? ""} onChange={(e) => update({ nudges: { phone: e.target.value } })} />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quiet from">
              <input className="input" type="time" value={n.quietStart} onChange={(e) => e.target.value && update({ nudges: { quietStart: e.target.value } })} />
            </Field>
            <Field label="Quiet until">
              <input className="input" type="time" value={n.quietEnd} onChange={(e) => e.target.value && update({ nudges: { quietEnd: e.target.value } })} />
            </Field>
          </div>
          <Field label="Timezone">
            <div className="flex gap-2">
              <input className="input" list="samjha-tz" value={n.timezone} onChange={(e) => update({ nudges: { timezone: e.target.value } })} />
              <button className="btn-ghost shrink-0" onClick={() => update({ nudges: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } })}>Detect</button>
            </div>
            <datalist id="samjha-tz">{timezones.map((z) => <option key={z} value={z} />)}</datalist>
          </Field>
          <p className="muted">In the week before an exam you&apos;ll get a nudge every day, and the night before we&apos;ll offer exam-eve mode.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button className="btn-ghost" onClick={() => void sendTest()}>Send me a nudge now</button>
          {nudgeMsg && <span className="muted">{nudgeMsg}</span>}
        </div>
        {nudges === null ? (
          <p className="muted">Loading nudge history…</p>
        ) : (
          <div className="space-y-2">
            {nudges.next && <p className="muted">Next check: {nudges.next.shouldSend ? "a nudge is ready to go out." : nudges.next.reason}.</p>}
            {nudges.list.length === 0 ? (
              <p className="muted">No nudges yet.</p>
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {nudges.list.slice(0, 6).map((x) => (
                  <li key={x.id} className="px-3 py-2 text-sm">
                    <div className="flex flex-wrap justify-between gap-x-3">
                      <span className="font-medium">{x.body}</span>
                      <span className="text-muted">{x.sent_at ? new Date(x.sent_at).toLocaleString() : ""}</span>
                    </div>
                    <div className="text-muted">
                      {CHANNEL_LABEL[x.channel] ?? x.channel} · {STATUS_LABEL[x.status ?? ""] ?? x.status}
                      {x.opened_at ? " · Opened" : ""}
                      {x.kind === "test" ? " · Test" : ""}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Section>

      <Section title="Exam dates and exports" hint="Say “export Anki” or “export gaps sheet”.">
        {subjects === null ? (
          <p className="muted">Loading subjects…</p>
        ) : subjectsError ? (
          <div className="flex items-center gap-2 text-sm text-red">
            {subjectsError}
            <button className="btn-ghost" onClick={() => void loadSubjects()}>Try again</button>
          </div>
        ) : subjects.length === 0 ? (
          <div className="space-y-2">
            <p className="muted">No subjects yet. Upload your notes to set exam dates and export decks.</p>
            <Link className="btn-primary" href="/subjects/new">Add a subject</Link>
          </div>
        ) : (
          <ul className="space-y-3">
            {subjects.map((s) => (
              <li key={s.id} className="rounded-xl border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{s.name}</span>
                  <label className="flex items-center gap-2 text-sm text-muted">
                    Exam
                    <input
                      type="date"
                      className="input w-auto py-1"
                      defaultValue={s.examDate ?? ""}
                      onChange={(e) => void saveExam(s.id, e.target.value)}
                      aria-label={`Exam date for ${s.name}`}
                    />
                    <span className="w-14 text-xs" aria-live="polite">
                      {examSaving[s.id] === "saving" ? "Saving…" : examSaving[s.id] === "saved" ? "Saved" : examSaving[s.id] === "error" ? "Failed" : ""}
                    </span>
                  </label>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <a className="btn-ghost" href={`/api/export/anki?subjectId=${encodeURIComponent(s.id)}`} download>Anki deck (.apkg)</a>
                  <a className="btn-ghost" href={`/api/export/gaps.pdf?subjectId=${encodeURIComponent(s.id)}`} download>Gaps-only sheet (PDF)</a>
                </div>
              </li>
            ))}
            {subjects.length > 1 && (
              <li>
                <a className="btn-ghost" href="/api/export/gaps.pdf" download>Gaps-only sheet for all subjects</a>
              </li>
            )}
          </ul>
        )}
        <p className="muted">Session transcripts can be downloaded from each topic&apos;s history.</p>
      </Section>

      <Section title="Chrome extension" hint="Paste this token in the Samjha extension's options to connect it.">
        {token.value ? (
          <div className="space-y-2">
            <code className="block break-all rounded-xl border border-line bg-surface-2 p-3 text-xs">{token.value}</code>
            <button className="btn-ghost" onClick={() => void copyToken()}>{token.copied ? "Copied" : "Copy token"}</button>
          </div>
        ) : (
          <button className="btn-ghost" disabled={token.loading} onClick={() => void loadToken()}>
            {token.loading ? "Getting token…" : "Show extension token"}
          </button>
        )}
        {token.error && <p className="text-sm text-red">{token.error}</p>}
      </Section>

      <Section title="Account">
        <Field label="Name">
          <div className="flex gap-2">
            <input className="input" value={name} maxLength={80} onChange={(e) => { setName(e.target.value); setNameState("idle"); }} onBlur={() => void saveName()} />
            <button className="btn-ghost shrink-0" disabled={!name.trim() || name.trim() === user.name || nameState === "saving"} onClick={() => void saveName()}>
              {nameState === "saving" ? "Saving…" : nameState === "saved" ? "Saved" : "Save"}
            </button>
          </div>
          {nameState === "error" && <p className="text-sm text-red">Couldn&apos;t save your name.</p>}
        </Field>
        {user.email && <p className="muted">Signed in as {user.email}</p>}
        {user.isDemo && <p className="muted">This is a demo account. It resets every hour.</p>}
        <button className="btn-ghost" onClick={() => void signOut()}>Sign out</button>
      </Section>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="card space-y-3">
      <div>
        <h2 className="h2">{title}</h2>
        {hint && <p className="muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}

function Toggle({ label, detail, checked, disabled, onChange }: { label: string; detail?: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {detail && <div className="truncate text-xs text-muted">{detail}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-7 w-12 shrink-0 rounded-full border border-line transition disabled:opacity-50 ${checked ? "bg-accent" : "bg-surface-2"}`}
      >
        <span className={`absolute top-0.5 h-5.5 w-5.5 rounded-full bg-surface shadow transition-all ${checked ? "left-[1.4rem]" : "left-0.5"}`} />
        <span className="sr-only">{checked ? "On" : "Off"}</span>
      </button>
    </div>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="space-y-1">
      <span className="text-sm font-medium">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1 rounded-xl border border-line bg-surface-2 p-1">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={`flex-1 rounded-lg px-3 py-1.5 text-sm whitespace-nowrap ${value === o.value ? "bg-surface font-medium shadow-sm" : "text-muted hover:text-fg"}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
