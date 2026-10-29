import type { Mastery } from "@/lib/types";

export const MASTERY_META: Record<Mastery, { colour: string; word: string; label: string; text: string; bg: string; border: string }> = {
  red: { colour: "Red", word: "Needs work", label: "Red: needs work", text: "text-red", bg: "bg-red-soft", border: "border-l-red" },
  amber: { colour: "Amber", word: "Review soon", label: "Amber: review soon", text: "text-amber", bg: "bg-amber-soft", border: "border-l-amber" },
  green: { colour: "Green", word: "Got it", label: "Green: got it", text: "text-green", bg: "bg-green-soft", border: "border-l-green" },
};

const SIZES = {
  sm: { icon: 14, text: "text-xs", pad: "px-1.5 py-0.5 gap-1" },
  md: { icon: 16, text: "text-sm", pad: "px-2 py-0.5 gap-1.5" },
  lg: { icon: 20, text: "text-base", pad: "px-2.5 py-1 gap-2" },
};

/** The shape carries the meaning too: cross = red, half-filled = amber, check = green. */
export function MasteryIcon({ mastery, size = 16 }: { mastery: Mastery; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 16 16", "aria-hidden": true as const, className: "shrink-0" };
  if (mastery === "green")
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path d="M4.6 8.3l2.2 2.2 4.6-4.8" fill="none" stroke="var(--surface)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (mastery === "amber")
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Mastery shown as icon + label, never colour alone (spec §7). */
export function MasteryBadge({
  mastery,
  size = "md",
  showLabel = true,
  className = "",
}: {
  mastery: Mastery;
  size?: "sm" | "md" | "lg";
  showLabel?: boolean;
  className?: string;
}) {
  const m = MASTERY_META[mastery] ?? MASTERY_META.red;
  const s = SIZES[size];
  return (
    <span
      role="img"
      aria-label={m.label}
      title={m.label}
      className={`inline-flex items-center rounded-full font-medium ${m.text} ${showLabel ? `${m.bg} ${s.pad}` : ""} ${s.text} ${className}`}
    >
      <MasteryIcon mastery={mastery} size={s.icon} />
      {showLabel && <span className="whitespace-nowrap text-fg">{m.word}</span>}
    </span>
  );
}

export default MasteryBadge;
