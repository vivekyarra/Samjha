import { notFound, redirect } from "next/navigation";
import { canAccessSubject, currentUser } from "@/lib/auth";
import { all, get } from "@/lib/db";
import { getSourcePage, supportingSentences } from "@/lib/ingest";
import { SourceViewer } from "./SourceViewer";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await get<{ file_name: string }>("SELECT file_name FROM sources WHERE id=?", id);
  return { title: s ? `${s.file_name} · Samjha` : "Notes · Samjha" };
}

export default async function SourcePage({
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
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined));
  const requested = parseInt(one("page") ?? "1", 10) || 1;
  const res = await getSourcePage(id, requested);
  if (!res || !await canAccessSubject(user.id, res.source.subject_id)) notFound();

  const claimId = one("claim");
  const claim = claimId
    ? await get<{ id: string; text: string }>(
        "SELECT c.id, c.text FROM claims c JOIN topics t ON t.id=c.topic_id WHERE c.id=? AND t.subject_id=?",
        claimId,
        res.source.subject_id,
      )
    : undefined;
  const query = claim?.text ?? one("q")?.slice(0, 300);
  const highlights = query ? supportingSentences(res.text, query, 2) : [];
  const pageClaims = await all<{ id: string; text: string; topic_id: string; topic_name: string }>(
    "SELECT c.id, c.text, c.topic_id, t.name AS topic_name FROM claims c JOIN topics t ON t.id=c.topic_id WHERE c.source_id=? AND c.page=? ORDER BY t.position, c.position",
    id,
    res.page,
  );
  const subject = (await get<{ id: string; name: string }>("SELECT id, name FROM subjects WHERE id=?", res.source.subject_id))!;

  return (
    <SourceViewer
      source={{ id, fileName: res.source.file_name, pages: res.pages, url: res.source.url }}
      subject={subject}
      page={res.page}
      text={res.text}
      highlights={highlights}
      claim={claim ?? null}
      pageClaims={pageClaims}
    />
  );
}
