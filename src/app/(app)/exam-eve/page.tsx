import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { userSubjects } from "@/lib/exameve";
import { ExamEve } from "./ExamEve";

export default async function ExamEvePage({ searchParams }: { searchParams: Promise<{ subjectId?: string; budget?: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const sp = await searchParams;
  const subjects = (await userSubjects(user.id)).map(({ id, name }) => ({ id, name }));
  if (!subjects.length) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <h1 className="h1">Exam-eve mode</h1>
        <div className="card space-y-3 text-center">
          <p className="muted">Exam-eve mode crash-revises only your weak topics. Upload your notes and explain a topic or two first.</p>
          <Link href="/subjects/new" className="btn-primary">Upload notes</Link>
        </div>
      </div>
    );
  }
  const budget = Number(sp.budget);
  return (
    <ExamEve
      subjects={subjects}
      initialSubjectId={sp.subjectId && subjects.some((s) => s.id === sp.subjectId) ? sp.subjectId : null}
      initialBudget={budget === 10 || budget === 20 ? budget : 5}
    />
  );
}
