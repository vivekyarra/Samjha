import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { all } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { MasteryBadge } from "@/components/ui/MasteryBadge";
import { loadClaims, loadTopic, topicMastery } from "@/components/session/load";
import { CiteChip } from "@/components/session/RichText";
import { TopicActions } from "@/components/session/topic/TopicActions";
import { citeHref } from "@/components/session/text";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  explain: "Explained",
  explain_back: "Explained back",
  review: "Review",
  viva: "Viva",
  exam_eve: "Exam-eve",
};

function attemptSummary(json: string | null): { covered: number; total: number } | null {
  if (!json) return null;
  try {
    const r = JSON.parse(json) as { claims?: { status?: string }[] };
    if (!Array.isArray(r.claims)) return null;
    return { covered: r.claims.filter((c) => c.status === "covered").length, total: r.claims.length };
  } catch {
    return null;
  }
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  const t = user ? await loadTopic(user.id, id) : null;
  return { title: t ? `${t.name} · Samjha` : "Topic · Samjha" };
}

export default async function TopicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) redirect("/login");
  const topic = await loadTopic(user.id, id);
  if (!topic) notFound();

  const claims = await loadClaims(user.id, topic.id);
  const attempts = await all<{ id: string; kind: string; created_at: string; result_json: string | null }>(
    "SELECT id, kind, created_at, result_json FROM attempts WHERE user_id = ? AND topic_id = ? ORDER BY created_at DESC LIMIT 15",
    user.id,
    topic.id,
  );
  const prereqs = await all<{ id: string; name: string }>(
    "SELECT t.id, t.name FROM prerequisites p JOIN topics t ON t.id = p.depends_on_topic_id WHERE p.topic_id = ? ORDER BY t.position",
    topic.id,
  );
  const dependants = await all<{ id: string; name: string }>(
    "SELECT t.id, t.name FROM prerequisites p JOIN topics t ON t.id = p.topic_id WHERE p.depends_on_topic_id = ? ORDER BY t.position",
    topic.id,
  );

  const colour = topicMastery(claims);
  const green = claims.filter((c) => c.mastery === "green").length;
  const firstCited = claims.find((c) => c.source_id);
  const notesHref = firstCited ? citeHref(firstCited.source_id, firstCited.page) : null;
  const dueIds = claims.filter((c) => c.due).map((c) => c.id);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <div className="space-y-2">
        <Link href={`/subjects/${topic.subject_id}`} className="text-sm text-muted hover:text-fg">
          ← {topic.subject_name}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="h1 min-w-0 break-words">{topic.name}</h1>
          <MasteryBadge mastery={colour} />
        </div>
        <p className="muted">
          {claims.length
            ? `${green} of ${claims.length} key idea${claims.length === 1 ? "" : "s"} mastered${dueIds.length ? ` · ${dueIds.length} due for review` : ""}`
            : "No key ideas yet"}
        </p>
      </div>

      <TopicActions
        topicId={topic.id}
        topicName={topic.name}
        subjectId={topic.subject_id}
        notesHref={notesHref}
        dueClaimIds={dueIds}
        hasClaims={claims.length > 0}
        inExam={!!topic.in_exam}
      />

      <section className="card" aria-labelledby="claims-h">
        <h2 id="claims-h" className="h2">
          Key ideas
        </h2>
        {claims.length ? (
          <ol className="mt-3 space-y-2">
            {claims.map((c, i) => {
              const href = citeHref(c.source_id, c.page);
              return (
                <li key={c.id} className="flex items-start gap-2 rounded-xl border border-line p-3">
                  <span className="w-5 shrink-0 text-sm font-semibold text-muted">{i + 1}.</span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words">{c.text}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <MasteryBadge mastery={c.mastery} />
                      {c.due && <span className="text-xs text-muted">due for review</span>}
                      {href && <CiteChip href={href} label={`${c.file_name ? `${c.file_name} · ` : ""}p.${c.page ?? 1}`} />}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="mt-3 space-y-2 text-center">
            <p className="muted">This topic has no key ideas yet. Add some, or upload notes that cover it.</p>
            <Link href={`/topics/${topic.id}/edit`} className="btn-ghost">
              Add key ideas
            </Link>
          </div>
        )}
      </section>

      {(prereqs.length > 0 || dependants.length > 0) && (
        <section className="card space-y-3">
          {prereqs.length > 0 && (
            <div>
              <h2 className="h2">Builds on</h2>
              <div className="mt-2 flex flex-wrap gap-2">
                {prereqs.map((p) => (
                  <Link key={p.id} href={`/topics/${p.id}`} className="btn-ghost">
                    {p.name}
                  </Link>
                ))}
              </div>
            </div>
          )}
          {dependants.length > 0 && (
            <div>
              <h2 className="h2">Needed for</h2>
              <div className="mt-2 flex flex-wrap gap-2">
                {dependants.map((p) => (
                  <Link key={p.id} href={`/topics/${p.id}`} className="btn-ghost">
                    {p.name}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      <section className="card" aria-labelledby="history-h">
        <h2 id="history-h" className="h2">
          Your attempts
        </h2>
        {attempts.length ? (
          <ul className="mt-3 divide-y divide-line">
            {attempts.map((a) => {
              const s = attemptSummary(a.result_json);
              return (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span>
                    <span className="font-medium">{KIND_LABEL[a.kind] ?? a.kind}</span>
                    <span className="text-muted"> · {fmtDate(a.created_at)}</span>
                  </span>
                  <span className="flex items-center gap-3">
                    {s && (
                      <span>
                        <span aria-hidden className="text-green">✓ </span>
                        {s.covered}/{s.total} covered
                      </span>
                    )}
                    <a href={`/api/export/transcript?attemptId=${a.id}`} className="text-xs text-muted underline hover:text-fg">
                      Transcript
                    </a>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted mt-2">No attempts yet. Say “explain this” to start your first one.</p>
        )}
      </section>
    </div>
  );
}
