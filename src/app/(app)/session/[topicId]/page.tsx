import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { loadClaims, loadTopic } from "@/components/session/load";
import { SessionFlow } from "@/components/session/SessionFlow";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export async function generateMetadata({ params }: { params: Promise<{ topicId: string }> }) {
  const { topicId } = await params;
  const user = await currentUser();
  const t = user ? await loadTopic(user.id, topicId) : null;
  return { title: t ? `Explain ${t.name} · Samjha` : "Session · Samjha" };
}

export default async function SessionPage({ params, searchParams }: { params: Promise<{ topicId: string }>; searchParams: Promise<SP> }) {
  const { topicId } = await params;
  const sp = await searchParams;
  const user = await currentUser();
  if (!user) redirect("/login");

  const topic = await loadTopic(user.id, topicId);
  if (!topic) notFound();
  const claims = await loadClaims(user.id, topic.id);

  if (!claims.length) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <h1 className="h1 break-words">{topic.name}</h1>
        <div className="card space-y-3 text-center">
          <p className="h2">No key ideas yet</p>
          <p className="muted">Samjha grades you against the key ideas from your notes, and this topic doesn&apos;t have any yet.</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Link href={`/topics/${topic.id}/edit`} className="btn-primary">
              Add key ideas
            </Link>
            <Link href={`/subjects/${topic.subject_id}`} className="btn-ghost">
              Upload more notes
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const kind = one(sp.kind) === "review" ? "review" : "explain";
  let onlyClaimIds: string[] | null = null;
  const requested = one(sp.claims).split(",").map((s) => s.trim()).filter(Boolean);
  if (requested.length) {
    const valid = new Set(claims.map((c) => c.id));
    const ids = requested.filter((id) => valid.has(id));
    if (ids.length) onlyClaimIds = ids;
  } else if (kind === "review") {
    const due = claims.filter((c) => c.due).map((c) => c.id);
    if (due.length) onlyClaimIds = due;
  }

  let returnTo: { id: string; name: string } | null = null;
  const rt = one(sp.returnTo);
  if (rt && rt !== topic.id) {
    const t = await loadTopic(user.id, rt);
    if (t) returnTo = { id: t.id, name: t.name };
  }

  const primarySourceId = claims.find((c) => c.source_id)?.source_id ?? null;

  return (
    <SessionFlow
      key={`${topic.id}-${kind}-${onlyClaimIds?.join(",") ?? ""}`}
      topic={{ id: topic.id, name: topic.name, subjectId: topic.subject_id }}
      claims={claims.map((c) => ({ id: c.id, text: c.text, source_id: c.source_id, page: c.page, mastery: c.mastery }))}
      kind={kind}
      onlyClaimIds={onlyClaimIds}
      isDemo={!!user.is_demo}
      returnTo={returnTo}
      primarySourceId={primarySourceId}
    />
  );
}
