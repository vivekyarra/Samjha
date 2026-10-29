"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";
import { useVoice, useVoiceScreen } from "@/lib/voice/context";

interface Props {
  source: { id: string; fileName: string; pages: number; url: string | null };
  subject: { id: string; name: string };
  page: number;
  text: string;
  highlights: string[];
  claim: { id: string; text: string } | null;
  pageClaims: { id: string; text: string; topic_id: string; topic_name: string }[];
}

/** Split text into plain and highlighted runs. Highlights are matched whitespace-insensitively. */
function segments(text: string, highlights: string[]): { text: string; mark: boolean }[] {
  const ranges: [number, number][] = [];
  for (const h of highlights) {
    const words = h.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (!words.length) continue;
    const m = new RegExp(words.join("\\s+")).exec(text);
    if (m) ranges.push([m.index, m.index + m[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const out: { text: string; mark: boolean }[] = [];
  let at = 0;
  for (const [s, e] of ranges) {
    if (s < at) continue;
    if (s > at) out.push({ text: text.slice(at, s), mark: false });
    out.push({ text: text.slice(s, e), mark: true });
    at = e;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false });
  return out;
}

export function SourceViewer({ source, subject, page, text, highlights, claim, pageClaims }: Props) {
  const router = useRouter();
  const voice = useVoice();
  const markRef = useRef<HTMLElement | null>(null);
  const segs = useMemo(() => segments(text, highlights), [text, highlights]);
  const href = (p: number) => `/sources/${source.id}?page=${p}${claim ? `&claim=${claim.id}` : ""}`;

  useEffect(() => {
    markRef.current?.scrollIntoView({ block: "center" });
  }, [page, highlights]);

  useVoiceScreen({
    hint: `Page ${page} of ${source.pages}. Say "next page", "page 3", "read this" or "back"`,
    mode: "browse",
    subjectId: subject.id,
    onInput: (raw) => {
      const s = raw.trim().toLowerCase().replace(/[.!?]+$/, "");
      let m: RegExpExecArray | null;
      if (/^(next|next page|forward)$/.test(s)) {
        if (page < source.pages) router.push(href(page + 1));
        else voice.speak("This is the last page.");
        return true;
      }
      if (/^(previous|previous page|prev|last page|go up)$/.test(s)) {
        if (page > 1) router.push(href(page - 1));
        else voice.speak("This is the first page.");
        return true;
      }
      if ((m = /^(?:go to |open )?page (\d+)$/.exec(s))) {
        const n = Math.min(Math.max(1, parseInt(m[1], 10)), source.pages);
        router.push(href(n));
        return true;
      }
      if (/^(read( this| it| the page)?|read aloud)$/.test(s)) {
        voice.speak(highlights.length ? highlights.join(" ") : text);
        return true;
      }
      if (/^(back|go back|close)$/.test(s)) {
        router.back();
        return true;
      }
      return false;
    },
  });

  let firstMark = true;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="space-y-1">
        <Link href={`/subjects/${subject.id}`} className="muted hover:text-fg">
          ← {subject.name}
        </Link>
        <h1 className="h2 break-words">{source.fileName}</h1>
        {source.url && (
          <a href={source.url} target="_blank" rel="noopener noreferrer" className="muted block truncate underline-offset-2 hover:underline">
            {source.url}
          </a>
        )}
      </div>

      {claim && (
        <div className="card border-l-4 border-l-accent text-sm">
          <span className="muted">Claim: </span>
          {claim.text}
          {!highlights.length && <p className="muted mt-1">The supporting text is on this page; it&apos;s worded differently in your notes.</p>}
        </div>
      )}

      <nav aria-label="Pages" className="flex items-center gap-2">
        {page > 1 ? (
          <Link href={href(page - 1)} className="btn-ghost px-3" aria-label="Previous page">
            ←
          </Link>
        ) : (
          <span className="btn-ghost px-3 opacity-40" aria-hidden>←</span>
        )}
        <form
          className="flex items-center gap-2 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            const n = parseInt(String(new FormData(e.currentTarget).get("p")), 10);
            if (n >= 1 && n <= source.pages) router.push(href(n));
          }}
        >
          <span className="muted">Page</span>
          <input name="p" key={page} defaultValue={page} inputMode="numeric" className="input w-16 px-2 py-1 text-center" aria-label="Page number" />
          <span className="muted">of {source.pages}</span>
        </form>
        {page < source.pages ? (
          <Link href={href(page + 1)} className="btn-ghost px-3" aria-label="Next page">
            →
          </Link>
        ) : (
          <span className="btn-ghost px-3 opacity-40" aria-hidden>→</span>
        )}
      </nav>

      <article className="card whitespace-pre-wrap break-words leading-relaxed" aria-label={`Page ${page} text`}>
        {text ? (
          segs.map((s, i) => {
            if (!s.mark) return <span key={i}>{s.text}</span>;
            const ref = firstMark ? (el: HTMLElement | null) => { markRef.current = el; } : undefined;
            firstMark = false;
            return (
              <mark key={i} ref={ref} className="rounded bg-amber-soft px-0.5 text-fg ring-1 ring-amber">
                {s.text}
              </mark>
            );
          })
        ) : (
          <span className="muted">This page has no text.</span>
        )}
      </article>

      {pageClaims.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Claims from this page</h2>
          <ul className="space-y-2">
            {pageClaims.map((c) => (
              <li key={c.id} className={`card py-3 text-sm ${claim?.id === c.id ? "border-accent" : ""}`}>
                <Link href={`/sources/${source.id}?page=${page}&claim=${c.id}`} className="block hover:underline">
                  {c.text}
                </Link>
                <Link href={`/subjects/${subject.id}?open=${c.topic_id}`} className="muted mt-1 inline-block hover:text-fg">
                  {c.topic_name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
