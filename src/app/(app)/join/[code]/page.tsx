import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser, canAccessSubject } from "@/lib/auth";
import { subjectByCode, normaliseCode } from "@/lib/class";
import { JoinClient } from "./JoinClient";

export const dynamic = "force-dynamic";

export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params;
  const user = await currentUser();
  if (!user) redirect("/login");
  const code = normaliseCode(decodeURIComponent(raw));
  const subject = await subjectByCode(code);
  if (!subject) {
    return (
      <div className="card mx-auto mt-8 max-w-md space-y-3 text-center">
        <p className="h2">Let&apos;s find the right class link</p>
        <p className="muted">The code may be mistyped, or the subject is no longer shared. Ask your classmate to send the link again.</p>
        <Link href="/home" className="btn-ghost">
          Back home
        </Link>
      </div>
    );
  }
  return <JoinClient code={code} name={subject.name} members={subject.members} alreadyMember={await canAccessSubject(user.id, subject.id)} subjectId={subject.id} />;
}
