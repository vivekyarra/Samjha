import Link from "next/link";
import { redirect } from "next/navigation";
import { canAccessSubject, currentUser } from "@/lib/auth";
import { getTopicWithClaims, listSubjects } from "@/lib/ingest";
import { UploadForm } from "../_components/UploadForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Add notes · Samjha" };

export default async function NewSubjectPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined));
  const subjects = (await listSubjects(user.id)).filter((s) => s.role === "owner");
  const subjectId = one("subjectId");
  const topicId = one("topicId");
  const t = topicId ? await getTopicWithClaims(topicId) : null;
  const topic = t && await canAccessSubject(user.id, t.subject_id) ? { id: t.id, name: t.name, subjectId: t.subject_id } : undefined;
  const mode = one("mode") === "syllabus" ? "syllabus" : one("mode") === "paste" ? "paste" : "upload";

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <Link href={topic ? `/subjects/${topic.subjectId}` : subjectId ? `/subjects/${subjectId}` : "/home"} className="muted hover:text-fg">
          ← Back
        </Link>
        <h1 className="h1 mt-1">{topic ? `Notes for ${topic.name}` : "Add your notes"}</h1>
        <p className="muted mt-1">Samjha turns them into topics and the key claims you should be able to explain, each linked to its page.</p>
      </div>
      <UploadForm
        subjects={subjects.map((s) => ({ id: s.id, name: s.name, topic_count: s.topic_count }))}
        initialSubjectId={subjectId && subjects.some((s) => s.id === subjectId) ? subjectId : undefined}
        topic={topic}
        initialMode={mode}
      />
    </div>
  );
}
