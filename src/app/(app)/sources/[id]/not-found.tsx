import { EmptyState } from "@/components/ui/EmptyState";

export default function SourceNotFound() {
  return (
    <div className="mx-auto max-w-xl">
      <EmptyState title="Notes not found" body="This file may have been removed from the subject." action={{ label: "Back to heatmap", href: "/home" }} />
    </div>
  );
}
