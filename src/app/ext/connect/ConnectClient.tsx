"use client";
import { useEffect, useState } from "react";

type ChromeRuntime = { runtime?: { sendMessage?: (id: string, msg: unknown, cb?: (r: unknown) => void) => void; lastError?: unknown } };

export default function ConnectClient({ name, token }: { name: string; token: string }) {
  const [status, setStatus] = useState<"idle" | "sent" | "copied" | "failed">("idle");

  useEffect(() => {
    const ext = new URLSearchParams(window.location.search).get("ext");
    const chrome = (window as unknown as { chrome?: ChromeRuntime }).chrome;
    if (!ext || !/^[a-p]{32}$/.test(ext) || !chrome?.runtime?.sendMessage) return;
    try {
      chrome.runtime.sendMessage(ext, { type: "samjha-token", token, name, origin: window.location.origin }, (r) => {
        setStatus(!chrome.runtime?.lastError && r ? "sent" : "idle");
      });
    } catch {
      /* extension not reachable from this origin; manual copy still works */
    }
  }, [token, name]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  }

  return (
    <main className="mx-auto max-w-md p-5 space-y-4">
      <h1 className="text-xl font-semibold">Connect the Samjha extension</h1>
      <p>Hi {name}. The extension uses this private key to save selections and grade your explanations.</p>
      {status === "sent" ? (
        <p role="status" className="rounded-lg bg-[var(--green-soft)] p-3">✓ Connected. You can close this tab and press Ctrl+Shift+Y on any page.</p>
      ) : (
        <>
          <ol className="list-decimal pl-5 space-y-1 text-[var(--muted)]">
            <li>Copy the key below.</li>
            <li>Open the extension&apos;s Options and paste it into &quot;Extension key&quot;.</li>
          </ol>
          <code className="block break-all rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3 text-sm">{token}</code>
          <button onClick={copy} className="rounded-lg bg-[var(--accent)] px-4 py-2 text-[var(--accent-fg)]">Copy key</button>
          {status === "copied" && <p role="status">✓ Copied.</p>}
          {status === "failed" && <p role="alert">Couldn&apos;t copy automatically. Select the key and copy it.</p>}
        </>
      )}
      <p className="text-sm text-[var(--muted)]">Keep this key private: anyone with it can add notes to your Samjha.</p>
    </main>
  );
}
