import Link from "next/link";
import type { Mastery } from "@/lib/types";
import { MasteryBadge, MASTERY_META } from "./MasteryBadge";

const BAR: Record<Mastery, string> = { red: "bg-red", amber: "bg-amber", green: "bg-green" };

/** Topic tile coloured by mastery, always with icon + label + percent. */
export function Tile({
  name,
  mastery,
  percent,
  href,
  due,
  inExam,
  claims,
  className = "",
}: {
  name: string;
  mastery: Mastery;
  /** Share of claims that are green, 0–100. */
  percent: number;
  href?: string;
  due?: number;
  inExam?: boolean;
  claims?: number;
  className?: string;
}) {
  const m = MASTERY_META[mastery] ?? MASTERY_META.red;
  const pct = Math.max(0, Math.min(100, Math.round(percent || 0)));
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="line-clamp-2 text-sm font-semibold leading-snug text-fg">{name}</span>
        {inExam && (
          <span className="shrink-0 rounded-md bg-surface px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted" title="Flagged: will be in the exam">
            Exam
          </span>
        )}
      </div>
      <div className="mt-auto flex items-center justify-between gap-2 pt-3">
        <MasteryBadge mastery={mastery} size="sm" />
        <span className="text-xs tabular-nums text-muted">{pct}%</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface" aria-hidden>
        <div className={`h-full ${BAR[mastery] ?? BAR.red}`} style={{ width: `${pct}%` }} />
      </div>
      {(!!due || claims !== undefined) && (
        <div className="mt-1.5 text-[11px] text-muted">
          {claims !== undefined && <span>{claims} claim{claims === 1 ? "" : "s"}</span>}
          {!!due && <span>{claims !== undefined ? " · " : ""}{due} due</span>}
        </div>
      )}
    </>
  );
  const cls = `flex min-h-28 flex-col rounded-2xl border border-line border-l-4 ${m.border} ${m.bg} p-3 transition ${className}`;
  const aria = `${name}: ${m.label}, ${pct}% green${due ? `, ${due} due` : ""}`;
  return href ? (
    <Link href={href} aria-label={aria} className={`${cls} hover:-translate-y-0.5 hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent`}>
      {body}
    </Link>
  ) : (
    <div aria-label={aria} className={cls}>
      {body}
    </div>
  );
}

export default Tile;
