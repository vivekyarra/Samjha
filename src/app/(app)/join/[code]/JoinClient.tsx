"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useVoice, useVoiceScreen } from "@/lib/voice/context";

export function JoinClient(props: { code: string; name: string; members: number; alreadyMember: boolean; subjectId: string }) {
  const router = useRouter();
  const voice = useVoice();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join() {
    if (props.alreadyMember) return router.push(`/class/${props.subjectId}`);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/class/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: props.code }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't join");
      voice.speak(`You're in ${props.name}.`);
      router.push(`/subjects/${data.subjectId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't join";
      setError(msg);
      voice.speak(msg);
      setBusy(false);
    }
  }

  useVoiceScreen({
    hint: props.alreadyMember ? 'Say "open class view"' : 'Say "join" to join this class, or "home" to go back',
    mode: "browse",
    subjectId: props.subjectId,
    onInput: (text) => {
      if (/\b(join|yes|ok(ay)?|sure|open class|class view)\b/i.test(text)) {
        void join();
        return true;
      }
      return false;
    },
  });

  return (
    <div className="card mx-auto mt-6 max-w-md space-y-4">
      <p className="muted">You&apos;ve been invited to</p>
      <h1 className="h1">{props.name}</h1>
      <p className="muted">
        {props.members} {props.members === 1 ? "person has" : "people have"} joined. You&apos;ll get the same topics and notes. Your own explanations and results stay private;
        the class only ever sees anonymous totals.
      </p>
      {props.alreadyMember ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Link href={`/subjects/${props.subjectId}`} className="btn-primary">
            Open subject
          </Link>
          <Link href={`/class/${props.subjectId}`} className="btn-ghost">
            Class view
          </Link>
        </div>
      ) : (
        <button type="button" className="btn-primary w-full" onClick={join} disabled={busy}>
          {busy ? "Joining…" : "Join this class"}
        </button>
      )}
      {error && (
        <p role="alert" className="text-sm text-red">
          {error}
        </p>
      )}
    </div>
  );
}
