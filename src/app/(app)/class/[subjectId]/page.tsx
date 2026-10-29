import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { currentUser, canAccessSubject } from "@/lib/auth";
import { classView, appOrigin, joinUrl } from "@/lib/class";
import { HeatmapView, MisunderstoodList } from "./HeatmapView";
import { ClassClient } from "./ClassClient";

export const dynamic = "force-dynamic";

export default async function ClassPage({ params }: { params: Promise<{ subjectId: string }> }) {
  const { subjectId } = await params;
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!await canAccessSubject(user.id, subjectId)) {
    return (
      <div className="card mx-auto mt-8 max-w-md text-center">
        <p className="h2">You&apos;re not in this class</p>
        <p className="muted mt-2">Ask a classmate for the join link or code, then open it to join.</p>
        <Link href="/home" className="btn-ghost mt-4">
          Back home
        </Link>
      </div>
    );
  }
  const view = await classView(user.id, subjectId);
  if (!view) {
    return (
      <div className="card mx-auto mt-8 max-w-md text-center">
        <p className="h2">Subject not found</p>
        <Link href="/home" className="btn-ghost mt-4">
          Back home
        </Link>
      </div>
    );
  }
  const origin = appOrigin(await headers());
  const share = view.subject.joinCode
    ? {
        code: view.subject.joinCode,
        joinUrl: joinUrl(origin, view.subject.joinCode),
        qrDataUrl: await QRCode.toDataURL(joinUrl(origin, view.subject.joinCode), { margin: 1, width: 320 }),
      }
    : null;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <Link href={`/subjects/${subjectId}`} className="text-sm text-muted hover:text-fg">
          ← {view.subject.name}
        </Link>
        <h1 className="h1">Class view</h1>
        <p className="muted">Everyone&apos;s results, combined and anonymous. No names, no individual results.</p>
      </header>
      <ClassClient
        subjectId={subjectId}
        subjectName={view.subject.name}
        isOwner={view.subject.isOwner}
        initialShare={share}
        reportUrl={`${origin}/report/${view.reportToken}`}
        pdfUrl={`/api/class/${subjectId}/report.pdf`}
        misunderstood={view.misunderstood.map((m) => ({ text: m.text, misconception: m.misconception }))}
        students={view.heatmap.students}
      />
      <HeatmapView heatmap={view.heatmap} />
      <MisunderstoodList items={view.misunderstood} />
    </div>
  );
}
