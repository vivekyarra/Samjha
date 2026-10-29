import { Spinner } from "@/components/ui";

export default function Loading() {
  return (
    <div className="flex justify-center py-20">
      <Spinner label="Getting things ready…" />
    </div>
  );
}
