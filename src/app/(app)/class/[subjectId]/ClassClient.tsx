"use client";
import { useRef, useState } from "react";
import { useVoice, useVoiceScreen } from "@/lib/voice/context";

interface Share { code: string; joinUrl: string; qrDataUrl: string }

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const el = document.createElement("textarea");
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      el.remove();
    }
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000);
  };
  return { copied, copy };
}

export function ClassClient(props: {
  subjectId: string;
  subjectName: string;
  isOwner: boolean;
  initialShare: Share | null;
  reportUrl: string;
  pdfUrl: string;
  misunderstood: { text: string; misconception: string }[];
  students: number;
}) {
  const voice = useVoice();
  const [share, setShare] = useState<Share | null>(props.initialShare);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const sendRef = useRef<HTMLDivElement>(null);
  const { copied, copy } = useCopy();

  async function doShare() {
    if (share) {
      voice.speak(`It's already shared. The join code is ${share.code.split("").join(" ")}.`);
      return;
    }
    if (!props.isOwner) {
      setError("Only the person who created this subject can share it.");
      voice.speak("Only the person who created this subject can share it.");
      return;
    }
    setSharing(true);
    setError(null);
    try {
      const res = await fetch(`/api/class/${props.subjectId}/share`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't share this subject");
      setShare(data);
      voice.speak("Shared. Classmates can scan the QR code or open the link to join.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't share this subject";
      setError(msg);
      voice.speak(msg);
    } finally {
      setSharing(false);
    }
  }

  function openSend() {
    setSendOpen(true);
    requestAnimationFrame(() => sendRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    voice.speak("Here's the professor report. Copy the link, download the PDF, or send it by email.");
  }

  const mailto = `mailto:?subject=${encodeURIComponent(`Class heatmap: ${props.subjectName}`)}&body=${encodeURIComponent(
    `Hello,\n\nHere is our class's anonymous understanding heatmap for ${props.subjectName} from Samjha. It shows which topics the class finds hardest and the most common misconceptions (counts only, no individual results):\n\n${props.reportUrl}\n\nIt takes under a minute to read. Thank you!`,
  )}`;

  useVoiceScreen({
    hint: share ? 'Say "send to professor" or "what\'s most misunderstood?"' : 'Say "share this subject" or "send to professor"',
    mode: "browse",
    subjectId: props.subjectId,
    onInput: (text) => {
      const t = text.toLowerCase();
      if (/\b(share|invite|join (link|code)|qr)\b/.test(t) && !/professor/.test(t)) {
        void doShare();
        return true;
      }
      if (/professor|report|\bsend\b|email|pdf/.test(t)) {
        openSend();
        if (/download|pdf/.test(t)) window.location.href = props.pdfUrl;
        return true;
      }
      if (/copy/.test(t) && share) {
        void copy("join", share.joinUrl);
        voice.speak("Join link copied.");
        return true;
      }
      if (/misunderstood|confus|hardest|wrong|weak/.test(t)) {
        if (!props.misunderstood.length) voice.speak("Still collecting responses. Once more classmates explain topics, the most misunderstood claims will show up here.");
        else voice.speak(props.misunderstood.slice(0, 3).map((m, i) => `${i + 1}. ${m.text}. ${m.misconception}`).join(" "));
        return true;
      }
      return false;
    },
  });

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="card space-y-3" aria-labelledby="share-heading">
        <h2 id="share-heading" className="h2">
          Invite classmates
        </h2>
        {share ? (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={share.qrDataUrl} alt={`QR code to join ${props.subjectName}`} className="h-40 w-40 shrink-0 self-center rounded-xl border border-line bg-white p-1" />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="muted">Join code</p>
              <p className="font-mono text-2xl font-semibold tracking-[0.2em]">{share.code}</p>
              <p className="break-all text-sm text-muted">{share.joinUrl}</p>
              <button type="button" className="btn-primary w-full sm:w-auto" onClick={() => copy("join", share.joinUrl)}>
                {copied === "join" ? "Copied ✓" : "Copy link"}
              </button>
            </div>
          </div>
        ) : props.isOwner ? (
          <>
            <p className="muted">Classmates join with their own accounts. They see the same topics; their study data stays personal.</p>
            <button type="button" className="btn-primary w-full sm:w-auto" onClick={doShare} disabled={sharing}>
              {sharing ? "Sharing…" : "Share this subject"}
            </button>
          </>
        ) : (
          <p className="muted">This subject isn&apos;t shared yet. Ask its creator to share it.</p>
        )}
        {error && (
          <p role="alert" className="text-sm text-red">
            {error}
          </p>
        )}
      </section>

      <section ref={sendRef} className="card space-y-3 scroll-mt-20" aria-labelledby="send-heading">
        <h2 id="send-heading" className="h2">
          Send to professor
        </h2>
        <p className="muted">
          A one-page anonymous report: class heatmap and the top 5 misunderstood claims. {props.students < 5 && "It fills in once 5 classmates have tried a topic."}
        </p>
        {!sendOpen ? (
          <button type="button" className="btn-ghost w-full sm:w-auto" onClick={openSend}>
            Send to professor
          </button>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2">
              <a href={props.reportUrl} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-sm text-accent underline">
                {props.reportUrl}
              </a>
              <button type="button" className="btn-ghost shrink-0 px-3 py-1" onClick={() => copy("report", props.reportUrl)}>
                {copied === "report" ? "Copied ✓" : "Copy"}
              </button>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <a href={props.pdfUrl} className="btn-primary" download>
                Download PDF
              </a>
              <a href={mailto} className="btn-ghost">
                Email it
              </a>
            </div>
            <p className="text-xs text-muted">Anyone with this link can see the anonymous report. It never shows names or individual results.</p>
          </div>
        )}
      </section>
    </div>
  );
}
