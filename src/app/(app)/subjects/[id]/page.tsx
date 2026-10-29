import { notFound, redirect } from "next/navigation";
import { canAccessSubject, currentUser } from "@/lib/auth";
import { getSubject } from "@/lib/ingest";
import { loadReview } from "../_components/load";
import { SubjectReview } from "../_components/SubjectReview";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getSubject(id);
  return { title: s ? `${s.name} · Samjha` : "Subject · Samjha" };
}

export default async function SubjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const sp = await searchParams;
  if (!await getSubject(id) || !await canAccessSubject(user.id, id)) notFound();
  const data = await loadReview(user.id, id);
  const open = typeof sp.open === "string" && data.topics.some((t) => t.id === sp.open) ? sp.open : undefined;
  return <SubjectReview {...data} initialOpen={open} />;
}
