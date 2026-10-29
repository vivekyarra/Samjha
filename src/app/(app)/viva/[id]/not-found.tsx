import Link from "next/link";
export default function NotFound() {
  return (
    <div className="card mx-auto max-w-xl text-center">
      <p className="font-semibold">Viva not found</p>
      <p className="muted mt-1">It may have been deleted, or it belongs to someone else.</p>
      <Link href="/viva" className="btn-primary mt-3">Back to viva</Link>
    </div>
  );
}
