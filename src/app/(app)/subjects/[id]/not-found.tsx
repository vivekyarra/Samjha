import { EmptyState } from "@/components/ui/EmptyState";

export default function SubjectNotFound() {
  return (
    <div className="mx-auto max-w-xl">
      <EmptyState title="Subject not found" body="It may have been deleted, or it belongs to someone else." action={{ label: "Back to heatmap", href: "/home" }} />
    </div>
  );
}
