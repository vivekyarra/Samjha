// Web fallback for the extension side panel: compact explain → grade → buddy → explain-back loop.
import Link from "next/link";
import { currentUser, canAccessSubject } from "@/lib/auth";
import { all, get } from "@/lib/db";
import type { Topic } from "@/lib/types";
import PanelClient, { type PanelClaim } from "./PanelClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Samjha — Teach this back" };

export default async function ExtPanelPage({ searchParams }: { searchParams: Promise<{ topicId?: string }> }) {
  const { topicId } = await searchParams;
  const user = await currentUser();
  if (!user) {
    const next = `/ext/panel${topicId ? `?topicId=${encodeURIComponent(topicId)}` : ""}`;
    return (
      <main className="p-4 space-y-3">
        <h1 className="text-lg font-semibold">Samjha</h1>
        <p className="text-[var(--muted)]">Sign in to explain this back.</p>
        <Link href={`/login?next=${encodeURIComponent(next)}`} target="_blank" className="inline-block rounded-lg bg-[var(--accent)] px-4 py-2 text-[var(--accent-fg)]">Open Samjha to sign in</Link>
      </main>
    );
  }
  const topic = topicId ? await get<Topic>("SELECT * FROM topics WHERE id=?", topicId) : undefined;
  if (!topic || !await canAccessSubject(user.id, topic.subject_id)) {
    return (
      <main className="p-4 space-y-3">
        <h1 className="text-lg font-semibold">Samjha</h1>
        <p className="text-[var(--muted)]">{topicId ? "Pick a topic to get started." : "Select text on any page and press Ctrl+Shift+Y (⌘⇧Y on Mac) to teach it back."}</p>
        <Link href="/home" className="underline">Go to Samjha</Link>
      </main>
    );
  }
  const claims = await all<PanelClaim>("SELECT id, text, page, source_id FROM claims WHERE topic_id=? ORDER BY position", topic.id);
  return <PanelClient topicId={topic.id} topicName={topic.name} claims={claims} />;
}
