"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useVoiceScreen } from "@/lib/voice/context";
import { Spinner } from "@/components/ui/Spinner";

type Mode = "upload" | "paste" | "syllabus";
type ItemStatus = "queued" | "working" | "done" | "error";

interface Item {
  key: string;
  label: string;
  file?: File;
  text?: string;
  syllabus?: boolean;
  status: ItemStatus;
  message?: string;
  progress?: { done?: number; total?: number };
  result?: { topicsCreated: number; claimsCreated: number; topicsMerged: number; pages: number; duplicate?: boolean; notice?: string };
}

const MAX_BYTES = 20 * 1024 * 1024;
const ACCEPT = ".pdf,.txt,.md,.markdown,.png,.jpg,.jpeg,.webp,.gif,application/pdf,text/plain,text/markdown,image/*";

function fmtSize(n: number) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function checkFile(f: File): string | null {
  if (f.size > MAX_BYTES) return "Over 20 MB. Split it into smaller files.";
  if (f.size === 0) return "This file is empty.";
  const ok = /\.(pdf|txt|md|markdown|png|jpe?g|webp|gif)$/i.test(f.name) || /^(application\/pdf|text\/|image\/(png|jpeg|webp|gif))/.test(f.type);
  return ok ? null : "Samjha reads PDF, text, Markdown and photos (PNG/JPG).";
}

export function UploadForm({
  subjects,
  initialSubjectId,
  topic,
  initialMode = "upload",
}: {
  subjects: { id: string; name: string; topic_count: number }[];
  initialSubjectId?: string;
  topic?: { id: string; name: string; subjectId: string };
  initialMode?: Mode;
}) {
  const router = useRouter();
  const [subjectId, setSubjectId] = useState<string>(topic?.subjectId ?? initialSubjectId ?? (subjects.length ? "" : "new"));
  const [name, setName] = useState("");
  const [examDate, setExamDate] = useState("");
  const [mode, setMode] = useState<Mode>(topic ? "paste" : initialMode);
  const [files, setFiles] = useState<File[]>([]);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [doneSubject, setDoneSubject] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const startRef = useRef(0);

  const isNew = subjectId === "new" || (!subjectId && !subjects.length);
  const chosen = subjects.find((s) => s.id === subjectId);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setElapsed(Math.round((Date.now() - startRef.current) / 1000)), 500);
    return () => clearInterval(t);
  }, [busy]);

  function addFiles(list: FileList | File[]) {
    const accepted: File[] = [];
    const errs: string[] = [];
    for (const f of Array.from(list)) {
      const e = checkFile(f);
      if (e) errs.push(`${f.name}: ${e}`);
      else accepted.push(f);
    }
    setFiles((cur) => [...cur, ...accepted.filter((a) => !cur.some((c) => c.name === a.name && c.size === a.size))]);
    setFileErrors(errs);
  }

  const canSubmit =
    !busy &&
    (isNew ? name.trim().length > 0 : !!subjectId) &&
    (mode === "upload" ? files.length > 0 : text.trim().length > 0);

  async function ensureSubject(): Promise<string> {
    if (!isNew) return subjectId;
    const res = await fetch("/api/subjects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim(), examDate: examDate || null }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Couldn't create the subject");
    setSubjectId(data.subject.id);
    return data.subject.id as string;
  }

  function patch(key: string, p: Partial<Item>) {
    setItems((cur) => cur.map((it) => (it.key === key ? { ...it, ...p } : it)));
  }

  async function runItem(sid: string, it: Item): Promise<boolean> {
    patch(it.key, { status: "working", message: "Uploading", progress: undefined });
    let body: BodyInit;
    const headers: Record<string, string> = { accept: "application/x-ndjson" };
    if (it.file) {
      const fd = new FormData();
      fd.append("file", it.file);
      if (topic) fd.append("topicId", topic.id);
      body = fd;
    } else {
      headers["content-type"] = "application/json";
      body = JSON.stringify({ text: it.text, fileName: it.label, mode: it.syllabus ? "syllabus" : "notes", topicId: topic?.id });
    }
    try {
      const res = await fetch(`/api/subjects/${sid}/sources?stream=1`, { method: "POST", headers, body });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        patch(it.key, { status: "error", message: data.error || "Upload didn't go through. Try again." });
        return false;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let ok = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.type === "progress") patch(it.key, { message: msg.message, progress: { done: msg.done, total: msg.total } });
          else if (msg.type === "result") {
            ok = true;
            patch(it.key, { status: "done", message: msg.notice, result: msg });
          } else if (msg.type === "error") patch(it.key, { status: "error", message: msg.error });
        }
        if (done) break;
      }
      return ok;
    } catch {
      patch(it.key, { status: "error", message: "Connection dropped. Check your internet and try again." });
      return false;
    }
  }

  async function submit(retryOnly = false) {
    if (busy) return;
    setError(null);
    let queue: Item[];
    if (retryOnly) {
      queue = items.filter((i) => i.status === "error").map((i) => ({ ...i, status: "queued" as const, message: undefined }));
      setItems((cur) => cur.map((i) => (i.status === "error" ? { ...i, status: "queued", message: undefined } : i)));
    } else {
      if (!canSubmit) return;
      queue =
        mode === "upload"
          ? files.map((f, i) => ({ key: `f${i}-${f.name}`, label: f.name, file: f, status: "queued" as const }))
          : [{ key: "text", label: mode === "syllabus" ? "Syllabus" : topic ? `Notes for ${topic.name}` : "Pasted notes", text, syllabus: mode === "syllabus", status: "queued" as const }];
      setItems(queue);
    }
    setBusy(true);
    startRef.current = Date.now();
    setElapsed(0);
    try {
      const sid = await ensureSubject();
      let allOk = true;
      for (const it of queue) allOk = (await runItem(sid, it)) && allOk;
      setDoneSubject(sid);
      if (allOk) {
        setFiles([]);
        setText("");
        setTimeout(() => router.push(topic ? `/subjects/${sid}?open=${topic.id}` : `/subjects/${sid}`), 1200);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  useVoiceScreen({
    hint: busy
      ? "Reading your notes…"
      : mode === "upload"
        ? 'Drop files, or say "paste notes", "syllabus", "call it Physics", then "start"'
        : 'Speak or paste your notes. Say "start" when ready',
    mode: "browse",
    onInput: (raw) => {
      const s = raw.trim().replace(/[.!?]+$/, "");
      let m: RegExpExecArray | null;
      if (/^(upload|files?|upload (a )?files?|choose files?)$/i.test(s)) {
        setMode("upload");
        return true;
      }
      if (/^(paste|type|paste (my )?notes|type (my )?notes|dictate( notes)?)$/i.test(s)) {
        setMode("paste");
        return true;
      }
      if (/^(syllabus|syllabus mode|topic list|i have a syllabus)$/i.test(s)) {
        setMode("syllabus");
        return true;
      }
      if ((m = /^(?:call it|name it|subject(?: name)?(?: is)?|new subject)\s+(.+)$/i.exec(s))) {
        setSubjectId("new");
        setName(m[1].replace(/^["']|["']$/g, ""));
        return true;
      }
      if ((m = /^(?:exam(?: date)?(?: is)?(?: on)?)\s+(.+)$/i.exec(s))) {
        const d = new Date(m[1]);
        if (!Number.isNaN(d.getTime())) {
          setExamDate(d.toISOString().slice(0, 10));
          return true;
        }
      }
      if ((m = /^(?:use|add (?:it )?to|put (?:it )?in)\s+(.+)$/i.exec(s))) {
        const hit = subjects.find((x) => x.name.toLowerCase().includes(m![1].toLowerCase()));
        if (hit) {
          setSubjectId(hit.id);
          return true;
        }
      }
      if (/^(start|go|process|submit|send|done|that's it|let's go|upload them|make topics)$/i.test(s)) {
        void submit();
        return true;
      }
      if (/^(clear|start over)$/i.test(s)) {
        setText("");
        setFiles([]);
        return true;
      }
      if (mode !== "upload" && raw.trim().split(/\s+/).length >= 3) {
        setText((t) => (t ? `${t}\n${raw.trim()}` : raw.trim()));
        return true;
      }
      return false;
    },
  });

  const total = items.reduce((s, i) => s + (i.result?.topicsCreated ?? 0), 0);
  const claims = items.reduce((s, i) => s + (i.result?.claimsCreated ?? 0), 0);
  const merged = items.reduce((s, i) => s + (i.result?.topicsMerged ?? 0), 0);
  const failed = items.some((i) => i.status === "error");
  const finished = !busy && items.length > 0 && items.every((i) => i.status === "done" || i.status === "error");

  return (
    <div className="space-y-5">
      {topic ? (
        <div className="card text-sm">
          Adding notes for <span className="font-semibold">{topic.name}</span>. Everything you add here goes into this topic.
        </div>
      ) : (
        <section className="card space-y-3" aria-labelledby="subject-label">
          <h2 id="subject-label" className="h2">Subject</h2>
          {subjects.length > 0 && (
            <select className="input" value={isNew ? "new" : subjectId} onChange={(e) => setSubjectId(e.target.value)} disabled={busy} aria-label="Choose subject">
              <option value="" disabled>Choose a subject…</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.topic_count} topics)
                </option>
              ))}
              <option value="new">+ New subject</option>
            </select>
          )}
          {isNew && (
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <label className="block">
                <span className="muted">Name</span>
                <input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Intro to Machine Learning" maxLength={120} disabled={busy} autoFocus={!subjects.length} />
              </label>
              <label className="block">
                <span className="muted">Exam date (optional)</span>
                <input className="input mt-1" type="date" value={examDate} onChange={(e) => setExamDate(e.target.value)} disabled={busy} />
              </label>
            </div>
          )}
          {chosen && !isNew && <p className="muted">New notes merge into {chosen.name}. Matching topics are combined and repeated claims are skipped.</p>}
        </section>
      )}

      <section className="card space-y-4">
        {!topic && (
          <div role="tablist" aria-label="How to add notes" className="flex gap-1 rounded-xl bg-surface-2 p-1">
            {(
              [
                ["upload", "Upload files"],
                ["paste", "Paste text"],
                ["syllabus", "Syllabus"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                role="tab"
                type="button"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                disabled={busy}
                className={`flex-1 rounded-lg px-3 py-2 text-sm ${mode === m ? "bg-surface font-medium shadow-sm" : "text-muted hover:text-fg"}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {mode === "upload" && !topic && (
          <div>
            <div
              role="button"
              tabIndex={0}
              aria-label="Drop files here or choose files"
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                if (!busy) addFiles(e.dataTransfer.files);
              }}
              className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 py-10 text-center transition ${dragging ? "border-accent bg-accent/5" : "border-line hover:bg-surface-2"}`}
            >
              <svg width="36" height="36" viewBox="0 0 24 24" aria-hidden className="text-muted">
                <path d="M12 16V4m0 0l-4 4m4-4l4 4M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <p className="font-medium">Drop your notes here</p>
              <p className="muted">PDF slides or notes, text, Markdown, or photos of handwritten pages. Up to 20 MB each.</p>
              <span className="btn-ghost mt-1">Choose files</span>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept={ACCEPT}
                className="sr-only"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
            {fileErrors.length > 0 && (
              <ul role="alert" className="mt-2 space-y-1 text-sm text-red">
                {fileErrors.map((e) => <li key={e}>{e}</li>)}
              </ul>
            )}
            {files.length > 0 && (
              <ul className="mt-3 divide-y divide-line rounded-xl border border-line">
                {files.map((f, i) => (
                  <li key={f.name + i} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
                    <span className="muted shrink-0">{fmtSize(f.size)}</span>
                    <button type="button" className="shrink-0 text-muted hover:text-fg" aria-label={`Remove ${f.name}`} disabled={busy} onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {(mode === "paste" || topic) && (
          <label className="block">
            <span className="muted">{topic ? `Paste or speak your notes on ${topic.name}` : "Paste or speak your notes. Headings help Samjha find topics."}</span>
            <textarea className="input mt-1 min-h-56 font-mono text-sm" value={text} onChange={(e) => setText(e.target.value)} disabled={busy} placeholder={"# Gradient descent\nGradient descent updates the weights in the opposite direction of the gradient…"} />
          </label>
        )}

        {mode === "syllabus" && !topic && (
          <label className="block">
            <span className="muted">One topic per line (or comma-separated). Samjha creates the topics, then asks for notes on each.</span>
            <textarea className="input mt-1 min-h-56 text-sm" value={text} onChange={(e) => setText(e.target.value)} disabled={busy} placeholder={"Unit 1: Linear regression, Loss functions\nUnit 2: Gradient descent\nBackpropagation\nOverfitting and regularisation"} />
          </label>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn-primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? "Working…" : mode === "syllabus" ? "Create topics" : "Find topics"}
          </button>
          {busy && <Spinner label={`${elapsed}s`} />}
          {!busy && !canSubmit && (
            <span className="muted">
              {isNew && !name.trim() ? "Name the subject first." : mode === "upload" ? "Add at least one file." : "Add some text."}
            </span>
          )}
        </div>
        {error && <p role="alert" className="text-sm text-red">{error}</p>}
      </section>

      {items.length > 0 && (
        <section className="card space-y-3" aria-live="polite">
          <h2 className="h2">Progress</h2>
          <ul className="space-y-2">
            {items.map((it) => (
              <li key={it.key} className="rounded-xl border border-line p-3 text-sm">
                <div className="flex items-center gap-2">
                  <span aria-hidden className={it.status === "done" ? "text-green" : it.status === "error" ? "text-red" : "text-muted"}>
                    {it.status === "done" ? "✓" : it.status === "error" ? "!" : it.status === "working" ? "…" : "•"}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{it.label}</span>
                  <span className="muted shrink-0">{it.status === "queued" ? "Waiting" : it.status === "working" ? "Working" : it.status === "done" ? "Done" : "Didn't finish"}</span>
                </div>
                {it.status === "working" && (
                  <div className="mt-2">
                    <p className="muted">
                      {it.message}
                      {it.progress?.total ? ` (${it.progress.done ?? 0}/${it.progress.total})` : ""}
                    </p>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
                      <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${it.progress?.total ? Math.max(8, ((it.progress.done ?? 0) / it.progress.total) * 100) : 30}%` }} />
                    </div>
                  </div>
                )}
                {it.status === "done" && it.result && (
                  <p className="muted mt-1">
                    {it.result.duplicate
                      ? "Already in this subject."
                      : `${it.result.pages} page${it.result.pages === 1 ? "" : "s"} · ${it.result.topicsCreated} new topic${it.result.topicsCreated === 1 ? "" : "s"} · ${it.result.claimsCreated} claim${it.result.claimsCreated === 1 ? "" : "s"}${it.result.topicsMerged ? ` · ${it.result.topicsMerged} merged into existing` : ""}`}
                  </p>
                )}
                {it.message && it.status !== "working" && <p className={`mt-1 ${it.status === "error" ? "text-red" : "muted"}`}>{it.message}</p>}
              </li>
            ))}
          </ul>
          {finished && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {doneSubject && (
                <Link href={`/subjects/${doneSubject}`} className="btn-primary">
                  {failed ? "See topics so far" : "Opening your topics…"}
                </Link>
              )}
              {failed && (
                <button type="button" className="btn-ghost" onClick={() => void submit(true)}>
                  Try failed ones again
                </button>
              )}
              {!failed && <span className="muted">{total} topics, {claims} claims{merged ? `, ${merged} merged` : ""} in {elapsed}s.</span>}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
