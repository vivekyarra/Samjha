import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentUser, canAccessSubject } from "@/lib/auth";
import { getGraphView } from "@/lib/graph";
import { GraphView } from "./GraphView";

export default async function GraphPage({ params, searchParams }: {
  params: Promise<{ subjectId: string }>;
  searchParams: Promise<{ trace?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { subjectId } = await params;
  const { trace } = await searchParams;
  if (!await canAccessSubject(user.id, subjectId)) notFound();
  const graph = await getGraphView(user.id, subjectId);
  if (!graph.nodes.length) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <h1 className="h1">{graph.subject.name}: concept graph</h1>
        <div className="card space-y-3 text-center">
          <p className="muted">No topics in this subject yet. Add notes and the graph of prerequisites will appear here.</p>
          <Link href={`/subjects/${subjectId}`} className="btn-primary">Add notes</Link>
        </div>
      </div>
    );
  }
  return <GraphView graph={graph} initialTrace={trace && graph.nodes.some((n) => n.id === trace) ? trace : null} />;
}
