import Link from "next/link";
import type { ReactNode } from "react";

export type EmptyAction = { label: string; href: string } | ReactNode;

function isLinkAction(a: EmptyAction): a is { label: string; href: string } {
  return !!a && typeof a === "object" && "href" in a && "label" in a && typeof (a as { href: unknown }).href === "string";
}

export function EmptyState({ title, body, action, icon }: { title: string; body?: ReactNode; action?: EmptyAction; icon?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-3 px-6 py-10 text-center">
      {icon ?? (
        <svg width="40" height="40" viewBox="0 0 24 24" aria-hidden className="text-muted">
          <rect x="4" y="3" width="16" height="18" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )}
      <h2 className="h2">{title}</h2>
      {body && <div className="muted max-w-sm">{body}</div>}
      {action && (isLinkAction(action) ? <Link href={action.href} className="btn-primary mt-1">{action.label}</Link> : action)}
    </div>
  );
}

export default EmptyState;
