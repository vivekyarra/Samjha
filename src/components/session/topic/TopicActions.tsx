"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useVoice, useVoiceScreen } from "@/lib/voice/context";
import type { IntentResult } from "@/lib/types";
import { RX } from "../text";

export function TopicActions({
  topicId,
  topicName,
  subjectId,
  notesHref,
  dueClaimIds,
  hasClaims,
  inExam: initialInExam,
}: {
  topicId: string;
  topicName: string;
  subjectId: string;
  notesHref: string | null;
  dueClaimIds: string[];
  hasClaims: boolean;
  inExam: boolean;
}) {
  const router = useRouter();
  const voice = useVoice();
  const [inExam, setInExam] = useState(initialInExam);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const sessionHref = `/session/${topicId}`;
  const reviewHref = dueClaimIds.length ? `/session/${topicId}?kind=review&claims=${dueClaimIds.join(",")}` : null;

  async function toggleExam(next = !inExam) {
    if (next === inExam) return;
    setSaving(true);
    setErr(null);
    setInExam(next);
    try {
      const res = await fetch(`/api/topics/${topicId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ in_exam: next }),
      });
      if (!res.ok) throw new Error();
      voice.speak(next ? `Flagged. ${topicName} will be in the exam.` : "Okay, unflagged.");
      router.refresh();
    } catch {
      setInExam(!next);
      setErr("Couldn't save that. Try again.");
    } finally {
      setSaving(false);
    }
  }

  useVoiceScreen({
    hint: `Say "explain this"${reviewHref ? `, "review"` : ""}, "show my notes" or "flag for the exam"`,
    mode: "browse",
    subjectId,
    topicId,
    onInput: (raw: string, intent: IntentResult) => {
      const t = raw.trim();
      if (t.split(/\s+/).length > 12) return false;
      if (RX.showNotes.test(t)) {
        if (notesHref) router.push(notesHref);
        else voice.speak("There are no notes linked to this topic yet.");
        return true;
      }
      if (reviewHref && RX.review.test(t)) { router.push(reviewHref); return true; }
      if (RX.explainThis.test(t) || intent.intent === "explanation") {
        if (hasClaims) router.push(sessionHref);
        else voice.speak("This topic has no key ideas yet. Say edit topic to add some.");
        return true;
      }
      if (RX.exam.test(t) || /unflag/i.test(t)) { void toggleExam(!/\b(not|unflag|remove)\b/i.test(t)); return true; }
      if (RX.edit.test(t)) { router.push(`/topics/${topicId}/edit`); return true; }
      if (RX.graph.test(t)) { router.push(`/graph/${subjectId}`); return true; }
      return false;
    },
  });

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {hasClaims ? (
          <Link href={sessionHref} className="btn-primary py-3 text-base">
            Explain this
          </Link>
        ) : (
          <span className="btn-primary py-3 text-base opacity-50" aria-disabled>
            Explain this
          </span>
        )}
        {reviewHref && (
          <Link href={reviewHref} className="btn-ghost py-3 text-base">
            Review {dueClaimIds.length} due idea{dueClaimIds.length === 1 ? "" : "s"}
          </Link>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {notesHref && (
          <Link href={notesHref} className="btn-ghost">
            Show my notes
          </Link>
        )}
        <Link href={`/topics/${topicId}/edit`} className="btn-ghost">
          Edit topic
        </Link>
        <Link href={`/graph/${subjectId}`} className="btn-ghost">
          Show graph
        </Link>
        <button
          type="button"
          role="switch"
          aria-checked={inExam}
          disabled={saving}
          onClick={() => void toggleExam()}
          className={`btn border ${inExam ? "border-accent bg-accent/15 text-fg" : "border-line bg-surface text-muted hover:bg-surface-2"}`}
        >
          <span aria-hidden>{inExam ? "★" : "☆"}</span>
          {inExam ? "Will be in the exam" : "Flag: will be in the exam"}
        </button>
      </div>
      {err && (
        <p className="text-sm text-red" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}
