import { currentUser } from "@/lib/auth";
import { listHistory, vivaSubjects } from "@/lib/viva";
import { VivaSetup } from "./_components/VivaSetup";

export const dynamic = "force-dynamic";
export const metadata = { title: "Viva · Samjha" };

export default async function VivaPage({ searchParams }: { searchParams: Promise<{ subjectId?: string }> }) {
  const user = await currentUser();
  if (!user) return null;
  const { subjectId } = await searchParams;
  return <VivaSetup subjects={await vivaSubjects(user.id)} history={await listHistory(user.id)} defaultSubjectId={subjectId} />;
}
