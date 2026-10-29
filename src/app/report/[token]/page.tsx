import type { Metadata } from "next";
import Link from "next/link";
import { classView, subjectFromToken } from "@/lib/class";
import { HeatmapView, MisunderstoodList } from "@/app/(app)/class/[subjectId]/HeatmapView";
import { PrintButton } from "./PrintButton";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Class report · Samjha", robots: { index: false, follow: false } };

export default async function ReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const subjectId = await subjectFromToken(token);
  const view = subjectId ? await classView(null, subjectId) : null;
  if (!view) {
    return (
      <main className="mx-auto w-full max-w-md px-4 py-16">
        <div className="card space-y-2 text-center">
          <p className="h2">Report not found</p>
          <p className="muted">This link is invalid or the subject was deleted. Ask the student who sent it for a fresh link.</p>
        </div>
      </main>
    );
  }
  const { heatmap, misunderstood } = view;
  const shown = heatmap.topics.filter((t) => !t.suppressed);
  const weakest = [...shown].sort((a, b) => (a.greenShare ?? 0) - (b.greenShare ?? 0))[0];
  const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 print:max-w-none print:px-0 print:py-0">
      <header className="space-y-1">
        <p className="text-sm font-semibold tracking-tight text-muted">
          Samjha<span className="text-accent">.</span> class report
        </p>
        <h1 className="h1">{heatmap.subjectName}</h1>
        <p className="muted">
          {date} · {heatmap.students} student{heatmap.students === 1 ? "" : "s"} · anonymous, counts only
        </p>
      </header>

      <section className="card space-y-1" aria-label="Summary">
        {weakest ? (
          <p>
            <span className="font-medium">Re-teach first:</span> {weakest.name} ({Math.round((weakest.greenShare ?? 0) * 100)}% of {weakest.attempted} students have it solid)
            {misunderstood[0] && (
              <>
                . <span className="font-medium">Top misconception:</span> {misunderstood[0].misconception}
              </>
            )}
          </p>
        ) : (
          <p>Collecting responses: each topic appears once {heatmap.minStudents} students have tried it. Check back after more classmates have studied.</p>
        )}
      </section>

      <div className="flex flex-wrap gap-2 print:hidden">
        <a href={`/api/class/${heatmap.subjectId}/report.pdf?token=${encodeURIComponent(token)}`} className="btn-primary" download>
          Download PDF
        </a>
        <PrintButton />
      </div>

      <HeatmapView heatmap={heatmap} isPublic />
      <MisunderstoodList items={misunderstood} />

      <footer className="border-t border-line pt-4 text-xs text-muted">
        Made with{" "}
        <Link href="/" className="underline">
          Samjha
        </Link>
        . Students explain topics out loud and get graded against their own notes. This report never shows names or individual results; a topic
        appears only after {heatmap.minStudents} students have tried it.
      </footer>
    </main>
  );
}
