import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { canAccessSubject, currentUser } from "@/lib/auth";
import { topicSubjectId } from "@/lib/ingest/review";
import { loadReview } from "../../../subjects/_components/load";
import { SubjectReview } from "../../../subjects/_components/SubjectReview";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit topic · Samjha" };

export default async function EditTopicPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const subjectId = await topicSubjectId(id);
  if (!subjectId || !await canAccessSubject(user.id, subjectId)) notFound();
  const data = await loadReview(user.id, subjectId);
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href={`/subjects/${subjectId}?open=${id}`} className="muted hover:text-fg">
        ← {data.subject.name}
      </Link>
      <SubjectReview {...data} singleTopicId={id} />
    </div>
  );
}
