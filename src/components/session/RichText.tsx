import Link from "next/link";
import type { ReactNode } from "react";

const TOKEN = /(\[[^\]]*\]\([^)\s]+\)|\*\*[^*]+\*\*)/g;

/** Small citation chip. Internal links use next/link. */
export function CiteChip({ href, label }: { href: string; label: string }) {
  const cls =
    "mx-0.5 inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-2 py-0.5 align-middle text-xs font-medium text-muted no-underline hover:text-fg focus:outline-none focus:ring-2 focus:ring-accent";
  const icon = (
    <svg aria-hidden width="10" height="12" viewBox="0 0 10 12" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M1 1h5l3 3v7H1z" />
    </svg>
  );
  if (href.startsWith("/")) {
    return (
      <Link href={href} className={cls} aria-label={`Source: ${label}`}>
        {icon}
        {label}
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls} aria-label={`Source: ${label}`}>
      {icon}
      {label}
    </a>
  );
}

/** Render buddy markdown-lite: [label](href) → citation chip, **bold** → strong. Newlines preserved by the container. */
export function RichText({ text }: { text: string }) {
  const parts = text.split(TOKEN);
  const out: ReactNode[] = [];
  parts.forEach((p, i) => {
    if (!p) return;
    const link = p.match(/^\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (link) {
      out.push(<CiteChip key={i} href={link[2]} label={link[1] || "source"} />);
      return;
    }
    const bold = p.match(/^\*\*([^*]+)\*\*$/);
    if (bold) {
      out.push(<strong key={i}>{bold[1]}</strong>);
      return;
    }
    out.push(<span key={i}>{p}</span>);
  });
  return <>{out}</>;
}
