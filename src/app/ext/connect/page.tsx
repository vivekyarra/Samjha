import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { extToken } from "@/app/api/ext/_shared";
import ConnectClient from "./ConnectClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connect the Samjha extension" };

export default async function ConnectPage() {
  const user = await currentUser();
  if (!user) {
    return (
      <main className="mx-auto max-w-md p-5 space-y-4">
        <h1 className="text-xl font-semibold">Connect the Samjha extension</h1>
        <p className="text-[var(--muted)]">Sign in first, then come back to this page.</p>
        <Link href="/login?next=/ext/connect" className="inline-block rounded-lg bg-[var(--accent)] px-4 py-2 text-[var(--accent-fg)]">Sign in to Samjha</Link>
      </main>
    );
  }
  return <ConnectClient name={user.name} token={extToken(user.id)} />;
}
