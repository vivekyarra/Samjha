import Link from "next/link";

/** Small chip linking to the citation viewer: /sources/ID?page=N */
export function Citation({
  sourceId,
  page,
  label,
  className = "",
}: {
  sourceId: string | null | undefined;
  page: number | null | undefined;
  label?: string;
  className?: string;
}) {
  if (!sourceId) return null;
  const p = page ?? 1;
  return (
    <Link
      href={`/sources/${encodeURIComponent(sourceId)}?page=${p}`}
      title={`Open your notes at page ${p}`}
      className={`inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 px-1.5 py-0.5 align-middle text-xs text-muted hover:text-fg ${className}`}
    >
      <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden>
        <path d="M4 1.5h5.5L13 5v9.5H4z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
      {label ?? `p.${p}`}
    </Link>
  );
}

export default Citation;
