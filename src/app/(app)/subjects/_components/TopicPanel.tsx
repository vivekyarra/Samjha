"use client";
import Link from "next/link";
import { useState } from "react";
import { MasteryBadge } from "@/components/ui/MasteryBadge";
import { citeHref, type ReviewTopic } from "./types";

export function TopicPanel({
  topic,
  canEdit,
  busy,
  prerequisites,
  sourceName,
  focusedClaim,
  onFocusClaim,
  splitMode,
  splitIds,
  onSplitMode,
  onToggleSplit,
  onClose,
  onRename,
  onDelete,
  onToggleExam,
  onSplit,
  onEditClaim,
  onDeleteClaim,
  onAddClaim,
  onOpenTopic,
}: {
  topic: ReviewTopic;
  canEdit: boolean;
  busy: boolean;
  prerequisites: { id: string; name: string }[];
  sourceName: Map<string, string>;
  focusedClaim: string | null;
  onFocusClaim: (id: string | null) => void;
  splitMode: boolean;
  splitIds: string[];
  onSplitMode: (on: boolean) => void;
  onToggleSplit: (id: string) => void;
  onClose?: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onToggleExam: () => void;
  onSplit: (name: string) => void;
  onEditClaim: (id: string, text: string) => void;
  onDeleteClaim: (id: string) => void;
  onAddClaim: (text: string) => void;
  onOpenTopic: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(topic.name);
  const [editing, setEditing] = useState<string | null>(null);
  const [claimDraft, setClaimDraft] = useState("");
  const [newClaim, setNewClaim] = useState("");
  const [splitName, setSplitName] = useState("");

  const t = topic;
  return (
    <article aria-labelledby={`title-${t.id}`} className="card space-y-4 border-2 border-accent/40">
      <div className="flex flex-wrap items-start gap-2">
        {renaming ? (
          <form
            className="flex min-w-0 flex-1 flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (nameDraft.trim() && nameDraft.trim() !== t.name) onRename(nameDraft.trim());
              setRenaming(false);
            }}
          >
            <input className="input min-w-0 flex-1" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} autoFocus aria-label="Topic name" maxLength={120} />
            <button className="btn-primary" type="submit">Save</button>
            <button className="btn-ghost" type="button" onClick={() => setRenaming(false)}>Cancel</button>
          </form>
        ) : (
          <h2 id={`title-${t.id}`} className="h2 min-w-0 flex-1 break-words">
            {t.name}
          </h2>
        )}
        {!renaming && t.claims.length > 0 && <MasteryBadge mastery={t.mastery} />}
        {onClose && !renaming && (
          <button type="button" className="btn-ghost px-2 py-1" onClick={onClose} aria-label="Close topic">
            ✕
          </button>
        )}
      </div>

      {prerequisites.length > 0 && (
        <p className="text-sm">
          <span className="muted">Builds on </span>
          {prerequisites.map((p, i) => (
            <span key={p.id}>
              {i > 0 && ", "}
              <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => onOpenTopic(p.id)}>
                {p.name}
              </button>
            </span>
          ))}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {t.claims.length > 0 ? (
          <Link href={`/session/${t.id}`} className="btn-primary">
            Explain this
          </Link>
        ) : (
          canEdit && (
            <Link href={`/subjects/new?topicId=${t.id}`} className="btn-primary">
              Add notes for this topic
            </Link>
          )
        )}
        <Link href={`/topics/${t.id}`} className="btn-ghost">
          Topic page
        </Link>
        <button type="button" className="btn-ghost" aria-pressed={!!t.in_exam} onClick={onToggleExam} disabled={busy}>
          {t.in_exam ? "★ In the exam" : "☆ Will be in the exam"}
        </button>
        {canEdit && (
          <>
            <button type="button" className="btn-ghost" onClick={() => { setNameDraft(t.name); setRenaming(true); }} disabled={busy}>
              Rename
            </button>
            {t.claims.length > 1 && (
              <button type="button" className="btn-ghost" aria-pressed={splitMode} onClick={() => onSplitMode(!splitMode)} disabled={busy}>
                {splitMode ? "Cancel split" : "Split"}
              </button>
            )}
            <button type="button" className="btn-ghost text-red" onClick={onDelete} disabled={busy}>
              Delete topic
            </button>
          </>
        )}
      </div>

      {splitMode && canEdit && (
        <form
          className="space-y-2 rounded-xl bg-surface-2 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (splitIds.length && splitIds.length < t.claims.length) onSplit(splitName.trim());
          }}
        >
          <p className="text-sm">Tick the claims to move into a new topic ({splitIds.length} picked).</p>
          <div className="flex flex-wrap gap-2">
            <input className="input min-w-0 flex-1" value={splitName} onChange={(e) => setSplitName(e.target.value)} placeholder={`New topic name (default: ${t.name} (part 2))`} aria-label="New topic name" maxLength={120} />
            <button type="submit" className="btn-primary" disabled={!splitIds.length || splitIds.length >= t.claims.length || busy}>
              Split off
            </button>
          </div>
          {splitIds.length >= t.claims.length && <p className="text-sm text-red">Leave at least one claim in {t.name}.</p>}
        </form>
      )}

      {t.claims.length === 0 ? (
        <p className="muted">No claims yet. Add notes for this topic, or type a claim below.</p>
      ) : (
        <ol className="space-y-2">
          {t.claims.map((c, i) => {
            const href = citeHref(c);
            const focused = focusedClaim === c.id;
            return (
              <li
                key={c.id}
                onMouseEnter={() => onFocusClaim(c.id)}
                onFocus={() => onFocusClaim(c.id)}
                className={`flex gap-3 rounded-xl border p-3 ${focused ? "border-accent bg-accent/5" : "border-line"}`}
              >
                {splitMode ? (
                  <input type="checkbox" className="mt-1 h-4 w-4 shrink-0" checked={splitIds.includes(c.id)} onChange={() => onToggleSplit(c.id)} aria-label={`Move claim ${i + 1}`} />
                ) : (
                  <span className="mt-0.5 w-5 shrink-0 text-right text-sm text-muted">{i + 1}.</span>
                )}
                <div className="min-w-0 flex-1 space-y-2">
                  {editing === c.id ? (
                    <form
                      className="space-y-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (claimDraft.trim() && claimDraft.trim() !== c.text) onEditClaim(c.id, claimDraft.trim());
                        setEditing(null);
                      }}
                    >
                      <textarea className="input min-h-20 text-sm" value={claimDraft} onChange={(e) => setClaimDraft(e.target.value)} autoFocus aria-label={`Edit claim ${i + 1}`} maxLength={400} />
                      <div className="flex gap-2">
                        <button className="btn-primary py-1" type="submit">Save</button>
                        <button className="btn-ghost py-1" type="button" onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    </form>
                  ) : (
                    <button type="button" className="block w-full text-left leading-relaxed" onClick={() => onFocusClaim(focused ? null : c.id)} aria-pressed={focused}>
                      {c.text}
                    </button>
                  )}
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <MasteryBadge mastery={c.mastery} size="sm" />
                    {href ? (
                      <Link href={href} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-muted hover:text-fg" title={`Open ${sourceName.get(c.source_id!) ?? "your notes"} at page ${c.page ?? 1}`}>
                        <span className="max-w-40 truncate">{sourceName.get(c.source_id!) ?? "Notes"}</span> · p.{c.page ?? 1}
                      </Link>
                    ) : (
                      <span className="text-muted">Added by you</span>
                    )}
                    {canEdit && editing !== c.id && (
                      <span className="ml-auto flex gap-1">
                        <button type="button" className="rounded px-2 py-1 text-muted hover:bg-surface-2 hover:text-fg" onClick={() => { setClaimDraft(c.text); setEditing(c.id); }} aria-label={`Edit claim ${i + 1}`} disabled={busy}>
                          Edit
                        </button>
                        <button type="button" className="rounded px-2 py-1 text-muted hover:bg-surface-2 hover:text-red" onClick={() => onDeleteClaim(c.id)} aria-label={`Delete claim ${i + 1}`} disabled={busy}>
                          Delete
                        </button>
                      </span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {canEdit && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (newClaim.trim().length >= 3) {
              onAddClaim(newClaim.trim());
              setNewClaim("");
            }
          }}
        >
          <input className="input min-w-0 flex-1" value={newClaim} onChange={(e) => setNewClaim(e.target.value)} placeholder="Add a claim you should be able to explain" aria-label="New claim" maxLength={400} />
          <button type="submit" className="btn-ghost" disabled={newClaim.trim().length < 3 || busy}>
            Add claim
          </button>
        </form>
      )}
    </article>
  );
}
