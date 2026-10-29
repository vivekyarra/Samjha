// Anonymous class heatmap + most-misunderstood list. Server-compatible (no hooks); used by /class and the public /report page.
import Link from "next/link";
import { MasteryBadge } from "@/components/ui/MasteryBadge";
import type { ClassHeatmap, ClassTopicCell } from "@/lib/class/aggregate";
import type { MisunderstoodClaim } from "@/lib/class";

const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);
const tileBg = { red: "bg-red-soft", amber: "bg-amber-soft", green: "bg-green-soft" } as const;

function Bar({ share }: { share: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2" role="presentation">
      <div className="h-full rounded-full bg-green" style={{ width: `${Math.round(share * 100)}%` }} />
    </div>
  );
}

function TopicTile({ t, min, isPublic }: { t: ClassTopicCell; min: number; isPublic: boolean }) {
  return (
    <details className={`group rounded-2xl border border-line p-4 print:break-inside-avoid ${t.colour ? tileBg[t.colour] : "bg-surface"}`}>
      <summary className="flex cursor-pointer list-none flex-col gap-2 [&::-webkit-details-marker]:hidden">
        <div className="flex items-start justify-between gap-2">
          <span className="font-medium leading-snug">{t.name}</span>
          {t.colour && <MasteryBadge mastery={t.colour} />}
        </div>
        {t.suppressed ? (
          <span className="muted">
            Collecting responses ({t.attempted}/{min})
          </span>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-2xl font-semibold tabular-nums">{pct(t.greenShare)}</span>
              <span className="muted">green · {t.attempted} students</span>
            </div>
            <Bar share={t.greenShare ?? 0} />
          </>
        )}
        <span className="text-xs text-muted group-open:hidden print:hidden">Tap for claims</span>
      </summary>
      <ul className="mt-3 space-y-3 border-t border-line pt-3">
        {t.claims.length === 0 && <li className="muted">No claims in this topic yet.</li>}
        {t.claims.map((c) => (
          <li key={c.claimId} className="space-y-1">
            <p className="text-sm leading-snug">
              {c.text}
              {c.sourceId && c.page && !isPublic && (
                <Link href={`/sources/${c.sourceId}?page=${c.page}`} className="ml-1 text-xs text-accent underline">
                  p.{c.page}
                </Link>
              )}
              {c.page && isPublic && <span className="ml-1 text-xs text-muted">p.{c.page}</span>}
            </p>
            {c.greenShare === null ? (
              <p className="text-xs text-muted">Hidden until {min} students have tried this topic.</p>
            ) : (
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <Bar share={c.greenShare} />
                </div>
                <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted">
                  {pct(c.greenShare)} green{c.wrong ? ` · ${c.wrong} wrong` : ""}
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function HeatmapView({ heatmap, isPublic = false }: { heatmap: ClassHeatmap; isPublic?: boolean }) {
  if (!heatmap.topics.length) {
    return (
      <div className="card text-center">
        <p className="font-medium">No topics yet</p>
        <p className="muted mt-1">Add notes to this subject and its topics will show up here.</p>
      </div>
    );
  }
  const shown = heatmap.topics.filter((t) => !t.suppressed).length;
  return (
    <section aria-labelledby="class-heatmap" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="class-heatmap" className="h2">
          Class heatmap
        </h2>
        <p className="muted">
          {heatmap.students} student{heatmap.students === 1 ? "" : "s"} · {shown}/{heatmap.topics.length} topics with enough data
        </p>
      </div>
      <p className="muted">
        Share of students who have each topic green. Anonymous counts only; a topic appears once {heatmap.minStudents} students have tried it.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 print:grid-cols-2">
        {heatmap.topics.map((t) => (
          <TopicTile key={t.topicId} t={t} min={heatmap.minStudents} isPublic={isPublic} />
        ))}
      </div>
    </section>
  );
}

export function MisunderstoodList({ items }: { items: MisunderstoodClaim[] }) {
  return (
    <section aria-labelledby="most-misunderstood" className="space-y-3">
      <h2 id="most-misunderstood" className="h2">
        Most misunderstood
      </h2>
      {items.length === 0 ? (
        <div className="card">
          <p className="muted">
            Collecting responses. Claims appear here once several students in a topic with 5+ students have them marked wrong.
          </p>
        </div>
      ) : (
        <ol className="space-y-3">
          {items.map((m, i) => (
            <li key={m.claimId} className="card space-y-1 print:break-inside-avoid">
              <p className="font-medium leading-snug">
                <span className="mr-1 text-muted">{i + 1}.</span>
                {m.text}
              </p>
              <p className="text-xs text-muted">
                {m.topicName} · marked wrong for {m.wrong} of {m.attempted} students
              </p>
              <p className="text-sm leading-relaxed">{m.misconception}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
