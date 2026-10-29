export function Spinner({ label = "Loading…", size = 20, className = "" }: { label?: string; size?: number; className?: string }) {
  return (
    <span role="status" aria-live="polite" className={`inline-flex items-center gap-2 text-muted ${className}`}>
      <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" aria-hidden>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
        <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      {label && <span className="text-sm">{label}</span>}
    </span>
  );
}

export default Spinner;
