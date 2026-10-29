import { Spinner } from "@/components/ui/Spinner";

export default function Loading() {
  return (
    <div className="mx-auto flex max-w-2xl justify-center py-16">
      <Spinner label="Loading…" />
    </div>
  );
}
