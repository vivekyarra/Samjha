// Compact shell for extension-facing pages (no app nav; fits a ~360px side panel).
export default function ExtLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh w-full bg-[var(--bg)] text-[var(--fg)] text-[15px]">{children}</div>;
}
