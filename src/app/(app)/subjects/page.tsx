import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { listSubjects } from "@/lib/ingest";
import { EmptyState } from "@/components/ui/EmptyState";

export const dynamic = "force-dynamic";
export const metadata = { title: "Subjects · Samjha" };

export default async function SubjectsPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const subjects = await listSubjects(user.id);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="h1 flex-1">Subjects</h1>
        <Link href="/subjects/new" className="btn-primary">
          Add notes
        </Link>
      </div>
      {subjects.length === 0 ? (
        <EmptyState title="No subjects yet" body="Upload your notes and Samjha will turn them into topics you can explain." action={{ label: "Upload notes", href: "/subjects/new" }} />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {subjects.map((s) => (
            <li key={s.id}>
              <Link href={`/subjects/${s.id}`} className="card block h-full hover:bg-surface-2">
                <h2 className="font-semibold">{s.name}</h2>
                <p className="muted mt-1">
                  {s.topic_count} topics · {s.claim_count} claims · {s.source_count} files{s.role !== "owner" ? " · shared with you" : ""}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
