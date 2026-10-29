// Public one-tap unsubscribe from nudges (link in every email / WhatsApp nudge).
import Link from "next/link";
import { unsubscribe } from "@/lib/nudges";

export const dynamic = "force-dynamic";
export const metadata = { title: "Unsubscribe · Samjha", robots: { index: false } };

export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : null;
  let result: { name: string } | null = null;
  let failed = false;
  try {
    result = await unsubscribe(token);
  } catch (e) {
    console.error("[unsubscribe]", e);
    failed = true;
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-16">
      <div className="card space-y-3 text-center">
        <p className="text-lg font-bold tracking-tight">
          Samjha<span className="text-accent">.</span>
        </p>
        {result ? (
          <>
            <h1 className="h1">You&apos;re unsubscribed</h1>
            <p className="muted">
              No more nudges for {result.name}. Your streak and reviews are still here whenever you want them.
            </p>
            <p className="muted">Changed your mind? Turn nudges back on in Settings.</p>
            <Link href="/settings" className="btn-primary w-full">Open settings</Link>
          </>
        ) : (
          <>
            <h1 className="h1">{failed ? "Something went wrong" : "This link has expired"}</h1>
            <p className="muted">
              {failed
                ? "We couldn't update your nudges just now. Please try the link again in a minute."
                : "The unsubscribe link is invalid or incomplete. You can turn nudges off in Settings."}
            </p>
            <Link href="/settings" className="btn-ghost w-full">Open settings</Link>
          </>
        )}
      </div>
    </main>
  );
}
