"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/home", label: "Heatmap" },
  { href: "/subjects", label: "Notes" },
  { href: "/review", label: "Review" },
  { href: "/exam-eve", label: "Exam-eve" },
  { href: "/viva", label: "Viva" },
  { href: "/style", label: "Style" },
  { href: "/settings", label: "Settings" },
];

export function AppNav({ user }: { user: { name: string; isDemo: boolean } }) {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
      {user.isDemo && (
        <div className="bg-accent px-4 py-1.5 text-center text-xs text-accent-fg">
          Guest workspace: hold your dictation key and explain a topic. Samjha finds what you missed.
        </div>
      )}
      <nav className="mx-auto flex max-w-5xl items-center gap-1 overflow-x-auto px-4 py-2">
        <Link href="/home" className="mr-3 shrink-0 text-lg font-bold tracking-tight">
          Samjha<span className="text-accent">.</span>
        </Link>
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-sm ${path.startsWith(l.href) ? "bg-surface-2 font-medium" : "text-muted hover:text-fg"}`}
          >
            {l.label}
          </Link>
        ))}
        <span className="ml-auto hidden shrink-0 text-sm text-muted sm:block">{user.name}</span>
      </nav>
    </header>
  );
}
