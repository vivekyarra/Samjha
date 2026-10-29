import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in · Samjha" };

/** Only same-origin paths like /ext/connect; anything else is ignored. */
function safeNext(v: string | undefined): string | null {
  return v && v.startsWith("/") && !v.startsWith("//") && !v.includes("\\") ? v : null;
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  const user = await currentUser();
  if (user && !user.is_demo) redirect(next ?? (user.onboarded ? "/home" : "/onboarding"));
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center px-4 py-4">
        <Link href="/" className="text-lg font-bold tracking-tight">
          Samjha<span className="text-accent">.</span>
        </Link>
      </header>
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 pb-20">
        <h1 className="h1">Sign in</h1>
        <p className="mt-1 muted">No password. Your name and email keep your notes and progress together.</p>
        <LoginForm next={next} />
        <div className="mt-8 border-t border-line pt-6 text-center">
          <p className="muted">Just looking around?</p>
          <Link href="/demo" prefetch={false} className="btn-ghost mt-3 w-full">Try Samjha now, no signup</Link>
        </div>
      </main>
    </div>
  );
}
