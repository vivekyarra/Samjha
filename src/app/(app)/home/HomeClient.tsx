"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Mastery } from "@/lib/types";
import type { DueToday, HeatmapTopic, NextToStudy, SubjectHeatmap } from "@/lib/mastery";
import { reviewHref } from "@/lib/mastery/rules";
import { useVoice, useVoiceScreen } from "@/lib/voice/context";
import { EmptyState, MasteryBadge, Tile } from "@/components/ui";

type Sort = "notes" | "red";
const SORT_KEY = "samjha.home.sort";
const RANK: Record<Mastery, number> = { red: 0, amber: 1, green: 2 };

function sortTopics(topics: HeatmapTopic[], sort: Sort) {
  if (sort === "notes") return topics;
  return [...topics].sort(
    (a, b) => RANK[a.mastery] - RANK[b.mastery] || b.dependants - a.dependants || Number(b.inExam) - Number(a.inExam) || a.greenPct - b.greenPct,
  );
}

// The stored sort is read straight from localStorage on the client; the server snapshot is null,
// so hydration matches the server render and the stored choice applies right after.
const noSubscribe = () => () => {};
function readStoredSort(): Sort | null {
  try {
    const s = localStorage.getItem(SORT_KEY);
    return s === "red" || s === "notes" ? s : null;
  } catch {
    /* storage unavailable */
    return null;
  }
}

function useRefreshOnFocus() {
  const router = useRouter();
  useEffect(() => {
    let last = Date.now();
    const refresh = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < 2000) return;
      last = Date.now();
      router.refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);
}

function dueSpeech(due: DueToday) {
  if (!due.total) return "Nothing is due for review today. Nice.";
  const names = due.topics.slice(0, 4).map((t) => `${t.name}, ${t.claimIds.length}`);
  return `${due.total} claim${due.total === 1 ? "" : "s"} due, about ${due.minutes} minutes: ${names.join("; ")}. Starting ${due.topics[0].name}.`;
}

export function HomeClient({
  name,
  heatmaps,
  due,
  next,
  streak,
}: {
  name: string;
  heatmaps: SubjectHeatmap[];
  due: DueToday;
  next: NextToStudy | null;
  streak: { days: number; today: boolean; longest: number };
}) {
  const router = useRouter();
  const voice = useVoice();
  const storedSort = useSyncExternalStore(noSubscribe, readStoredSort, () => null);
  const [chosenSort, setSortState] = useState<Sort | null>(null);
  const sort: Sort = chosenSort ?? storedSort ?? "notes";
  useRefreshOnFocus();

  const setSort = (s: Sort) => {
    setSortState(s);
    try {
      localStorage.setItem(SORT_KEY, s);
    } catch {
      /* ignore */
    }
  };

  const firstReview = due.topics[0] ? reviewHref(due.topics[0].topicId, due.topics[0].claimIds) : null;
  const hasTopics = heatmaps.some((h) => h.topics.length > 0);

  useVoiceScreen({
    hint: hasTopics ? 'Try "what should I study now?", "red first", "what\'s due?" or "open [topic]"' : 'Say "add notes" to upload your first notes',
    mode: "browse",
    onInput: (text) => {
      const t = text.toLowerCase().trim();
      if (/what (should|do|can) i (study|learn|do)|study (now|next)|what next|where (should|do) i start/.test(t)) {
        if (!next) {
          voice.speak(hasTopics ? "Nothing is red or amber right now. Everything you've studied is solid." : "Upload your notes first, then I'll tell you where to start.");
          return true;
        }
        voice.speak(`${next.reason} Let's open it.`);
        router.push(`/topics/${next.topicId}`);
        return true;
      }
      if (/\b(red|worst|weakest) first\b|sort by (red|mastery|colou?r)/.test(t)) {
        setSort("red");
        voice.speak("Showing red topics first.");
        return true;
      }
      if (/(notes|original|default|normal) order/.test(t)) {
        setSort("notes");
        voice.speak("Back to notes order.");
        return true;
      }
      if (/what'?s due|what is due|due today|start (the |my )?review|today'?s review/.test(t)) {
        voice.speak(dueSpeech(due));
        if (firstReview) router.push(firstReview);
        return true;
      }
      if (/^(add|upload) (my |new |more )?notes/.test(t)) {
        router.push("/subjects/new");
        return true;
      }
      return false;
    },
  });

  if (!heatmaps.length) {
    return (
      <div className="mx-auto max-w-xl py-6">
        <h1 className="h1 mb-4">Hi {name.split(" ")[0]}</h1>
        <EmptyState
          title="Upload your first notes"
          body="Drop a PDF, paste your notes or add a syllabus. Samjha turns them into topics, then you explain each one back and watch this heatmap go green."
          action={{ label: "Upload your first notes", href: "/subjects/new" }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="h1">Hi {name.split(" ")[0]}</h1>
        <StreakChip streak={streak} />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <section className="card flex flex-col gap-2" aria-labelledby="next-h">
          <h2 id="next-h" className="muted font-medium uppercase tracking-wide">Study next</h2>
          {next ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-lg font-semibold">{next.name}</span>
                <MasteryBadge mastery={next.mastery} size="sm" />
              </div>
              <p className="muted">{next.reason}</p>
              <div className="mt-1 flex flex-wrap gap-2">
                <Link href={`/topics/${next.topicId}`} className="btn-primary">Open topic</Link>
                <Link href={`/session/${next.topicId}?kind=explain`} className="btn-ghost">Explain it now</Link>
              </div>
            </>
          ) : (
            <p className="muted">{hasTopics ? "Nothing red or amber. Everything you've studied is solid." : "Add notes to get topics to study."}</p>
          )}
        </section>

        <section className="card flex flex-col gap-2" aria-labelledby="due-h">
          <h2 id="due-h" className="muted font-medium uppercase tracking-wide">Due today</h2>
          {due.total ? (
            <>
              <p className="text-lg font-semibold">
                {due.total} claim{due.total === 1 ? "" : "s"} · about {due.minutes} min
              </p>
              <ul className="flex flex-col gap-1 text-sm">
                {due.topics.slice(0, 3).map((t) => (
                  <li key={t.topicId} className="flex items-center justify-between gap-2">
                    <span className="truncate">{t.name}</span>
                    <span className="shrink-0 text-muted">{t.claimIds.length} due</span>
                  </li>
                ))}
                {due.topics.length > 3 && <li className="text-muted">+{due.topics.length - 3} more topics</li>}
              </ul>
              <div className="mt-1 flex flex-wrap gap-2">
                {firstReview && <Link href={firstReview} className="btn-primary">Start review</Link>}
                <Link href="/review" className="btn-ghost">See all</Link>
              </div>
            </>
          ) : (
            <p className="muted">Nothing due. Nice.</p>
          )}
        </section>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="Sort topics" className="inline-flex rounded-xl border border-line bg-surface p-1 text-sm">
          {(["notes", "red"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={sort === s}
              onClick={() => setSort(s)}
              className={`rounded-lg px-3 py-1.5 ${sort === s ? "bg-surface-2 font-medium" : "text-muted"}`}
            >
              {s === "notes" ? "Notes order" : "Red first"}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/exam-eve" className="btn-ghost">Exam-eve</Link>
          <Link href="/subjects/new" className="btn-ghost">+ Add notes</Link>
        </div>
      </div>

      {heatmaps.map((h) => (
        <SubjectSection key={h.subject.id} h={h} sort={sort} />
      ))}
    </div>
  );
}

function StreakChip({ streak }: { streak: { days: number; today: boolean } }) {
  const label = streak.days
    ? `${streak.days}-day streak${streak.today ? "" : " · explain something today to keep it"}`
    : "No streak yet · explain a topic to start one";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-sm" aria-label={label}>
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden className={streak.days ? "text-amber" : "text-muted"}>
        <path d="M12 2c1 4 5 6 5 11a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5 0 2 1 3 2 3 0-3-1-6 1-9.5z" fill="currentColor" />
      </svg>
      <span className="font-semibold tabular-nums">{streak.days}</span>
      <span className="text-muted">{streak.days ? `day${streak.days === 1 ? "" : "s"}${streak.today ? "" : " · keep it going"}` : "start a streak"}</span>
    </span>
  );
}

function SubjectSection({ h, sort }: { h: SubjectHeatmap; sort: Sort }) {
  const topics = useMemo(() => sortTopics(h.topics, sort), [h.topics, sort]);
  const [now] = useState(() => Date.now());
  const exam = h.subject.examDate ? new Date(h.subject.examDate) : null;
  const daysToExam = exam && !Number.isNaN(exam.getTime()) ? Math.ceil((exam.getTime() - now) / 86400000) : null;
  return (
    <section className="flex flex-col gap-3" aria-labelledby={`s-${h.subject.id}`}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id={`s-${h.subject.id}`} className="h2">
            <Link href={`/subjects/${h.subject.id}`} className="hover:underline">{h.subject.name}</Link>
          </h2>
          <p className="muted">
            {h.summary.topics} topic{h.summary.topics === 1 ? "" : "s"} · {h.summary.greenPct}% green
            {daysToExam !== null && daysToExam >= 0 && ` · exam ${daysToExam === 0 ? "today" : daysToExam === 1 ? "tomorrow" : `in ${daysToExam} days`}`}
          </p>
        </div>
        <nav aria-label={`${h.subject.name} links`} className="flex flex-wrap gap-1.5 text-sm">
          <Link href={`/graph/${h.subject.id}`} className="rounded-lg px-2.5 py-1 text-muted hover:bg-surface-2 hover:text-fg">Graph</Link>
          <Link href={`/class/${h.subject.id}`} className="rounded-lg px-2.5 py-1 text-muted hover:bg-surface-2 hover:text-fg">Class</Link>
          <Link href={`/subjects/${h.subject.id}`} className="rounded-lg px-2.5 py-1 text-muted hover:bg-surface-2 hover:text-fg">Edit</Link>
        </nav>
      </div>
      {topics.length ? (
        <>
          <div className="flex flex-wrap gap-3 text-xs text-muted" aria-label="Claim totals">
            <span className="inline-flex items-center gap-1"><MasteryBadge mastery="red" size="sm" showLabel={false} /> {h.summary.red} needs work</span>
            <span className="inline-flex items-center gap-1"><MasteryBadge mastery="amber" size="sm" showLabel={false} /> {h.summary.amber} review soon</span>
            <span className="inline-flex items-center gap-1"><MasteryBadge mastery="green" size="sm" showLabel={false} /> {h.summary.green} got it</span>
          </div>
          <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
            {topics.map((t) => (
              <li key={t.id} className="flex">
                <Tile
                  className="w-full"
                  name={t.name}
                  mastery={t.mastery}
                  percent={t.greenPct}
                  href={`/topics/${t.id}`}
                  due={t.due}
                  inExam={t.inExam}
                  claims={t.counts.total}
                />
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="card muted">
          No topics yet. <Link href={`/subjects/${h.subject.id}`} className="text-accent underline">Add notes to this subject</Link>.
        </div>
      )}
    </section>
  );
}
