import { notFound } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getView, sessionOwner } from "@/lib/viva";
import { VivaSession } from "../_components/VivaSession";

export const dynamic = "force-dynamic";
export const metadata = { title: "Viva session · Samjha" };

export default async function VivaSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  const { id } = await params;
  if (!user || await sessionOwner(id) !== user.id) notFound();
  return <VivaSession initial={await getView(id)} />;
}
