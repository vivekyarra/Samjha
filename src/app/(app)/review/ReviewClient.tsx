"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import type { DueToday, DueTopic } from "@/lib/mastery";
import { reviewHref } from "@/lib/mastery/rules";
import { useVoice, useVoiceScreen } from "@/lib/voice/context";
import { EmptyState, MasteryBadge } from "@/components/ui";

function listSpeech(due: DueToday) {
  if (!due.total) return "Nothing due today. Nice.";
  const names = due.topics.slice(0, 5).map((t) => `${t.name}, ${t.claimIds.length} claim${t.claimIds.length === 1 ? "" : "s"}`);
  const more = due.topics.length > 5 ? `, and ${due.topics.length - 5} more topics` : "";
  return `${due.total} claim${due.total === 1 ? "" : "s"} due today, about ${due.minutes} minutes. ${names.join("; ")}${more}. Starting with ${due.topics[0].name}.`;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

function findTopic(topics: DueTopic[], text: string): DueTopic | undefined {
  const q = norm(text);
  if (!q) return undefined;
  return topics.find((t) => norm(t.name) === q) ?? topics.find((t) => q.includes(norm(t.name)) || norm(t.name).includes(q));
}

export function ReviewClient({ due, streak, autoStart, hasSubjects }: { due: DueToday; streak: number; autoStart: boolean; hasSubjects: boolean }) {
  const router = useRouter();
  const voice = useVoice();
  const started = useRef(false);

  const start = (t: DueTopic | undefined) => {
    if (!t) return false;
    router.push(reviewHref(t.topicId, t.claimIds));
    return true;
  };

  useEffect(() => {
    const refresh = () => document.visibilityState === "visible" && router.refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [router]);

  useEffect(() => {
    if (!autoStart || started.current) return;
    started.current = true;
    voice.speak(listSpeech(due));
    start(due.topics[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  useVoiceScreen({
    hint: due.total ? `${due.total} due · say "start", "start ${due.topics[0].name}" or "what's due today?"` : 'Nothing due · say "what should I study?" or "home"',
    mode: "browse",
    onInput: (text) => {
      const t = norm(text);
      if (/what s due|what is due|due today|today s review|read (me )?the list/.test(t)) {
        voice.speak(listSpeech(due));
        start(due.topics[0]);
        return true;
      }
      const m = t.match(/^(?:start|begin|review|let s go)(?: reviewing| review(?:ing)?| with)?\s*(.*)$/);
      if (m) {
        const rest = m[1].replace(/^(the )?(first|next)( one| topic)?$/, "").trim();
        if (!due.total) {
          if (rest) return false;
          voice.speak("Nothing is due right now. Nice.");
          return true;
        }
        const target = rest ? findTopic(due.topics, rest) : due.topics[0];
        if (!target) return false;
        voice.speak(`Reviewing ${target.name}.`);
        return start(target);
      }
      return false;
    },
  });

  if (!due.total) {
    return (
      <div className="mx-auto max-w-xl py-6">
        <h1 className="h1 mb-4">Today&apos;s review</h1>
        {hasSubjects ? (
          <EmptyState
            title="Nothing due. Nice."
            body="Claims you've got right come back here when they start to fade. Meanwhile, fix something red."
            action={{ label: "Back to heatmap", href: "/home" }}
          />
        ) : (
          <EmptyState title="Nothing to review yet" body="Upload notes and explain a topic. Reviews show up here when it's time." action={{ label: "Upload your first notes", href: "/subjects/new" }} />
        )}
      </div>
    );
  }

  const first = due.topics[0];
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <div>
        <h1 className="h1">Today&apos;s review</h1>
        <p className="muted mt-1">
          {due.total} claim{due.total === 1 ? "" : "s"} across {due.topics.length} topic{due.topics.length === 1 ? "" : "s"} · about {due.minutes} min
          {streak > 0 && ` · ${streak}-day streak`}
        </p>
      </div>

      <Link href={reviewHref(first.topicId, first.claimIds)} className="btn-primary w-full py-3 text-base sm:w-auto sm:self-start">
        Start review: {first.name}
      </Link>

      <ul className="flex flex-col gap-2">
        {due.topics.map((t) => (
          <li key={t.topicId} className="card flex items-center justify-between gap-3 p-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/topics/${t.topicId}`} className="truncate font-medium hover:underline">{t.name}</Link>
                <MasteryBadge mastery="amber" size="sm" />
              </div>
              <p className="muted truncate">
                {t.subjectName} · {t.claimIds.length} claim{t.claimIds.length === 1 ? "" : "s"} due · ~{Math.max(1, t.claimIds.length * 2)} min
              </p>
            </div>
            <Link href={reviewHref(t.topicId, t.claimIds)} className="btn-ghost shrink-0" aria-label={`Start review of ${t.name}`}>
              Start
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
