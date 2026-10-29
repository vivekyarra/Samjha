import { Spinner } from "@/components/ui/Spinner";

export default function Loading() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="h1">My style</h1>
      <Spinner label="Loading your style…" />
    </div>
  );
}
