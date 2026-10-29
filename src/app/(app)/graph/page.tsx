import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { userSubjects } from "@/lib/exameve";

export default async function GraphIndex() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const subjects = await userSubjects(user.id);
  if (subjects.length === 1) redirect(`/graph/${subjects[0].id}`);
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="h1">Concept graph</h1>
      {subjects.length === 0 ? (
        <div className="card space-y-3 text-center">
          <p className="muted">No subjects yet. Upload your notes and Samjha will map how the topics connect.</p>
          <Link href="/subjects/new" className="btn-primary">Upload notes</Link>
        </div>
      ) : (
        <ul className="space-y-2">
          {subjects.map((s) => (
            <li key={s.id}>
              <Link href={`/graph/${s.id}`} className="card block hover:bg-surface-2">{s.name}</Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
