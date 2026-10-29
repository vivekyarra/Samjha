"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function LoginForm({ next }: { next?: string | null }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email }),
      });
      const data = (await res.json().catch(() => ({}))) as { redirect?: string; error?: string };
      if (!res.ok) throw new Error(data.error || "Couldn't sign you in. Try again.");
      router.replace(next || data.redirect || "/home");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't sign you in. Try again.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Your name</span>
        <input className="input" autoComplete="name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Riya" required />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Email</span>
        <input className="input" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="riya@college.edu" required />
      </label>
      {error && <p role="alert" className="rounded-xl border border-red/40 bg-red-soft px-3 py-2 text-sm text-red">{error}</p>}
      <button type="submit" className="btn-primary w-full py-3" disabled={busy || !name.trim() || !email.trim()}>
        {busy ? "Signing in…" : "Continue"}
      </button>
    </form>
  );
}
