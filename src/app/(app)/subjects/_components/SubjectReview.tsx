"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVoice, useVoiceScreen } from "@/lib/voice/context";
import type { Mastery } from "@/lib/types";
import { MasteryBadge } from "@/components/ui/MasteryBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { parseReviewCommand, type ReviewCommand } from "@/lib/ingest/commands";
import { bestMatch } from "@/lib/ingest/fuzzy";
import { TopicPanel } from "./TopicPanel";
import { api, type ReviewClaim, type ReviewSource, type ReviewSubject, type ReviewTopic } from "./types";

interface Pending { say: string; run: () => Promise<void> }
interface Toast { text: string; tone: "ok" | "error"; undo?: () => void }

const GROUPS: { key: string; title: string; test: (t: ReviewTopic) => boolean }[] = [
  { key: "notes", title: "Needs notes", test: (t) => t.claims.length === 0 },
  { key: "red", title: "To learn", test: (t) => t.claims.length > 0 && t.mastery === "red" },
  { key: "amber", title: "Review soon", test: (t) => t.claims.length > 0 && t.mastery === "amber" },
  { key: "green", title: "Got it", test: (t) => t.claims.length > 0 && t.mastery === "green" },
];

interface DeletedClaim { topicId: string; claim: ReviewClaim; index: number }

/** Holds the most recently deleted claim for undo. Read and written only from handlers, never during render. */
function useUndoSlot() {
  const ref = useRef<DeletedClaim | null>(null);
  return useMemo(
    () => ({
      peek: () => ref.current,
      put: (d: DeletedClaim) => {
        ref.current = d;
      },
      take: () => {
        const d = ref.current;
        ref.current = null;
        return d;
      },
    }),
    [],
  );
}

function topicMastery(claims: ReviewClaim[]): Mastery {
  if (!claims.length) return "red";
  const green = claims.filter((c) => c.mastery === "green").length / claims.length;
  return green >= 0.9 ? "green" : green >= 0.4 ? "amber" : "red";
}

export function SubjectReview({
  subject,
  topics: initialTopics,
  prerequisites,
  sources,
  canEdit,
  initialOpen,
  singleTopicId,
}: {
  subject: ReviewSubject;
  topics: ReviewTopic[];
  prerequisites: { topic_id: string; depends_on_topic_id: string }[];
  sources: ReviewSource[];
  canEdit: boolean;
  initialOpen?: string;
  /** Edit-one-topic mode (used by /topics/[id]/edit). */
  singleTopicId?: string;
}) {
  const router = useRouter();
  const voice = useVoice();
  const [topics, setTopics] = useState(initialTopics);
  const [openId, setOpenId] = useState<string | null>(singleTopicId ?? initialOpen ?? null);
  const [selected, setSelected] = useState<string[]>([]);
  const [selectMode, setSelectMode] = useState(false);
  const [focusedClaim, setFocusedClaim] = useState<string | null>(null);
  const [splitIds, setSplitIds] = useState<string[]>([]);
  const [splitMode, setSplitMode] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [busy, setBusy] = useState(false);
  const lastDeleted = useUndoSlot();

  // Fresh server data (router.refresh) replaces the local copy.
  const [topicsFrom, setTopicsFrom] = useState(initialTopics);
  if (topicsFrom !== initialTopics) {
    setTopicsFrom(initialTopics);
    setTopics(initialTopics);
  }
  useEffect(() => {
    if (initialOpen) document.getElementById(`topic-${initialOpen}`)?.scrollIntoView({ block: "center" });
  }, [initialOpen]);

  const open = topics.find((t) => t.id === openId) ?? null;
  const names = useMemo(() => new Map(topics.map((t) => [t.id, t.name])), [topics]);

  // Each new toast restarts the auto-dismiss clock; dismissing or replacing it cancels the old one.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.undo ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [toast]);

  function notify(text: string, tone: Toast["tone"] = "ok", undo?: () => void, speak = false) {
    setToast({ text, tone, undo });
    if (speak) voice.speak(text);
  }

  async function act(fn: () => Promise<void>, spoken = false) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(e instanceof Error ? e.message : "That didn't save. Try again.", "error", undefined, spoken);
    } finally {
      setBusy(false);
    }
  }

  const updateTopic = (id: string, f: (t: ReviewTopic) => ReviewTopic) =>
    setTopics((cur) => cur.map((t) => (t.id === id ? (() => { const n = f(t); return { ...n, mastery: topicMastery(n.claims) }; })() : t)));

  const masteryOf = (claimId: string): Mastery => {
    for (const t of topics) for (const c of t.claims) if (c.id === claimId) return c.mastery;
    return "red";
  };
  const fromApiTopic = (t: { id: string; name: string; position: number; in_exam: number; claims: Omit<ReviewClaim, "mastery">[] }): ReviewTopic => {
    const claims = t.claims.map((c) => ({ ...c, mastery: masteryOf(c.id) }));
    return { id: t.id, name: t.name, position: t.position, in_exam: t.in_exam, claims, mastery: topicMastery(claims) };
  };

  // ---- actions (used by taps and by voice) ----
  const renameTopic = (id: string, name: string, spoken = false) =>
    act(async () => {
      const r = await api<{ topic: { name: string } }>(`/api/topics/${id}`, { method: "PATCH", body: { name } });
      updateTopic(id, (t) => ({ ...t, name: r.topic.name }));
      notify(`Renamed to ${r.topic.name}.`, "ok", undefined, spoken);
    }, spoken);

  const toggleExam = (t: ReviewTopic) =>
    act(async () => {
      await api(`/api/topics/${t.id}`, { method: "PATCH", body: { inExam: !t.in_exam } });
      updateTopic(t.id, (x) => ({ ...x, in_exam: x.in_exam ? 0 : 1 }));
    });

  const deleteTopic = (id: string, spoken = false) =>
    act(async () => {
      const name = names.get(id);
      await api(`/api/topics/${id}`, { method: "DELETE" });
      setTopics((cur) => cur.filter((t) => t.id !== id));
      if (openId === id) setOpenId(null);
      setSelected((s) => s.filter((x) => x !== id));
      notify(`Deleted ${name}.`, "ok", undefined, spoken);
      if (singleTopicId) router.push(`/subjects/${subject.id}`);
      else router.refresh();
    }, spoken);

  const mergeTopics = (ids: string[], name?: string, spoken = false) =>
    act(async () => {
      const ordered = [...ids].sort((a, b) => (topics.find((t) => t.id === a)?.position ?? 0) - (topics.find((t) => t.id === b)?.position ?? 0));
      const label = ordered.map((id) => names.get(id)).join(" and ");
      const r = await api<{ topic: Parameters<typeof fromApiTopic>[0] }>("/api/topics/merge", { method: "POST", body: { ids: ordered, name } });
      const merged = fromApiTopic(r.topic);
      setTopics((cur) => cur.filter((t) => !ordered.slice(1).includes(t.id)).map((t) => (t.id === merged.id ? merged : t)));
      setSelected([]);
      setSelectMode(false);
      setOpenId(merged.id);
      notify(`Merged ${label} into ${merged.name}.`, "ok", undefined, spoken);
      router.refresh();
    }, spoken);

  const splitTopic = (topicId: string, claimIds: string[], name: string, spoken = false) =>
    act(async () => {
      const r = await api<{ original: Parameters<typeof fromApiTopic>[0]; created: Parameters<typeof fromApiTopic>[0] }>(`/api/topics/${topicId}/split`, {
        method: "POST",
        body: { claimIds, name },
      });
      const original = fromApiTopic(r.original), created = fromApiTopic(r.created);
      setTopics((cur) => {
        const out: ReviewTopic[] = [];
        for (const t of cur) {
          if (t.id === original.id) out.push(original, created);
          else out.push(t.position > original.position ? { ...t, position: t.position + 1 } : t);
        }
        return out;
      });
      setSplitIds([]);
      setSplitMode(false);
      notify(`Split ${claimIds.length} claim${claimIds.length === 1 ? "" : "s"} into ${created.name}.`, "ok", undefined, spoken);
      router.refresh();
    }, spoken);

  const editClaim = (topicId: string, claimId: string, text: string, spoken = false) =>
    act(async () => {
      const r = await api<{ claim: { text: string } }>(`/api/claims/${claimId}`, { method: "PATCH", body: { text } });
      updateTopic(topicId, (t) => ({ ...t, claims: t.claims.map((c) => (c.id === claimId ? { ...c, text: r.claim.text } : c)) }));
      notify("Claim updated.", "ok", undefined, spoken);
    }, spoken);

  const addClaim = (topicId: string, text: string, spoken = false) =>
    act(async () => {
      const r = await api<{ claim: Omit<ReviewClaim, "mastery"> }>("/api/claims", { method: "POST", body: { topicId, text } });
      updateTopic(topicId, (t) => ({ ...t, claims: [...t.claims, { ...r.claim, mastery: "red" }] }));
      notify("Claim added.", "ok", undefined, spoken);
    }, spoken);

  const restoreClaim = () =>
    act(async () => {
      const d = lastDeleted.take();
      if (!d) return;
      const r = await api<{ claim: Omit<ReviewClaim, "mastery"> }>("/api/claims", {
        method: "POST",
        body: { topicId: d.topicId, text: d.claim.text, sourceId: d.claim.source_id, page: d.claim.page, position: d.claim.position },
      });
      updateTopic(d.topicId, (t) => {
        const claims = [...t.claims];
        claims.splice(Math.min(d.index, claims.length), 0, { ...r.claim, mastery: "red" });
        return { ...t, claims };
      });
      notify("Claim restored.");
    });

  const deleteClaim = (topicId: string, claimId: string, spoken = false) =>
    act(async () => {
      const t = topics.find((x) => x.id === topicId);
      const index = t?.claims.findIndex((c) => c.id === claimId) ?? -1;
      if (!t || index < 0) return;
      await api(`/api/claims/${claimId}`, { method: "DELETE" });
      lastDeleted.put({ topicId, claim: t.claims[index], index });
      updateTopic(topicId, (x) => ({ ...x, claims: x.claims.filter((c) => c.id !== claimId) }));
      if (focusedClaim === claimId) setFocusedClaim(null);
      notify(`Deleted claim ${index + 1}. Say "undo" to bring it back.`, "ok", () => void restoreClaim(), spoken);
    }, spoken);

  // ---- voice ----
  const findTopic = (q: string) => bestMatch(q, topics, (t) => t.name, 0.5)?.item ?? null;
  const claimAt = (t: ReviewTopic, n: number | undefined) => (n === undefined ? undefined : n === -1 ? t.claims.at(-1) : t.claims[n - 1]);

  function runCommand(cmd: ReviewCommand): boolean {
    const say = (s: string) => voice.speak(s);
    const needEdit = () => {
      if (canEdit) return false;
      say("Only the subject owner can change topics.");
      return true;
    };
    switch (cmd.kind) {
      case "confirm":
        if (!pending) return false;
        void pending.run();
        setPending(null);
        return true;
      case "cancel":
        if (!pending) return false;
        setPending(null);
        say("Okay, cancelled.");
        return true;
      case "undo":
        if (!lastDeleted.peek()) {
          say("There's nothing to undo.");
          return true;
        }
        void restoreClaim();
        return true;
      case "open": {
        const t = findTopic(cmd.name);
        if (!t) return false;
        setOpenId(t.id);
        document.getElementById(`topic-${t.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        say(`${t.name}: ${t.claims.length} claims.`);
        return true;
      }
      case "close":
        if (!open || singleTopicId) return false;
        setOpenId(null);
        return true;
      case "read": {
        if (!open) {
          say("Open a topic first, for example: open gradient descent.");
          return true;
        }
        say(open.claims.length ? `${open.name}. ${open.claims.map((c, i) => `${i + 1}. ${c.text}`).join(" ")}` : `${open.name} has no claims yet.`);
        return true;
      }
      case "select": {
        const t = findTopic(cmd.name);
        if (!t) return false;
        setSelectMode(true);
        setSelected((s) => (s.includes(t.id) ? s.filter((x) => x !== t.id) : [...s, t.id]));
        say(`Selected ${t.name}.`);
        return true;
      }
      case "merge": {
        if (needEdit()) return true;
        let ids: string[] = [];
        if (cmd.a && cmd.b) {
          const a = findTopic(cmd.a), b = findTopic(cmd.b);
          if (!a || !b || a.id === b.id) {
            say(`I couldn't find ${!a ? cmd.a : cmd.b}. Say the topic names as they appear on the cards.`);
            return true;
          }
          ids = [a.id, b.id];
        } else if (selected.length >= 2) ids = selected;
        else {
          setSelectMode(true);
          say("Which two? Tap the topics to select them, or say: merge backpropagation and chain rule.");
          return true;
        }
        void mergeTopics(ids, cmd.into, true);
        return true;
      }
      case "rename": {
        if (needEdit()) return true;
        const t = cmd.from ? findTopic(cmd.from) : open;
        if (!t) {
          say(cmd.from ? `I couldn't find ${cmd.from}.` : "Open a topic first, or say: rename backprop to backpropagation.");
          return true;
        }
        void renameTopic(t.id, cmd.to, true);
        return true;
      }
      case "delete_claim": {
        if (needEdit()) return true;
        const t = open ?? topics.find((x) => x.claims.some((c) => c.id === focusedClaim));
        const c = t ? (cmd.index !== undefined ? claimAt(t, cmd.index) : t.claims.find((x) => x.id === focusedClaim)) : undefined;
        if (!t || !c) {
          say(t ? "Which claim? Say, for example: delete claim 2." : "Open a topic first, then say which claim to delete.");
          return true;
        }
        void deleteClaim(t.id, c.id, true);
        return true;
      }
      case "delete_topic": {
        if (needEdit()) return true;
        const t = cmd.name ? findTopic(cmd.name) : open;
        if (!t) {
          say(cmd.name ? `I couldn't find ${cmd.name}.` : "Which topic? Say: delete topic and its name.");
          return true;
        }
        const q = `Delete ${t.name} and its ${t.claims.length} claims? Say yes to confirm.`;
        setPending({ say: q, run: () => deleteTopic(t.id, true) });
        say(q);
        return true;
      }
      case "split": {
        if (needEdit()) return true;
        if (!open) {
          say("Open the topic you want to split first.");
          return true;
        }
        const ids = cmd.claims?.length ? cmd.claims.map((n) => claimAt(open, n)?.id).filter((x): x is string => !!x) : splitIds;
        if (!ids.length) {
          setSplitMode(true);
          say("Tap the claims to move into a new topic, or say: split claims 2 and 3 into a name.");
          return true;
        }
        if (ids.length >= open.claims.length) {
          say("Leave at least one claim in the original topic.");
          return true;
        }
        void splitTopic(open.id, ids, cmd.name ?? "", true);
        return true;
      }
      case "edit_claim": {
        if (needEdit()) return true;
        const t = open;
        const c = t ? (cmd.index !== undefined ? claimAt(t, cmd.index) : t.claims.find((x) => x.id === focusedClaim)) : undefined;
        if (!t || !c) {
          say("Which claim? Say, for example: change claim 2 to, and the new wording.");
          return true;
        }
        void editClaim(t.id, c.id, cmd.text, true);
        return true;
      }
      case "add_claim":
        if (needEdit()) return true;
        if (!open) {
          say("Open a topic first, then add the claim.");
          return true;
        }
        void addClaim(open.id, cmd.text, true);
        return true;
      case "add_notes":
        router.push(open && !open.claims.length ? `/subjects/new?topicId=${open.id}` : `/subjects/new?subjectId=${subject.id}`);
        return true;
      case "start": {
        const t = cmd.name ? findTopic(cmd.name) : open?.claims.length ? open : topics.find((x) => x.claims.length && x.mastery === "red") ?? topics.find((x) => x.claims.length);
        if (!t) return false;
        if (!t.claims.length) {
          say(`${t.name} needs notes first.`);
          return true;
        }
        router.push(`/session/${t.id}`);
        return true;
      }
    }
  }

  useVoiceScreen({
    hint: pending
      ? pending.say
      : open
        ? `${open.name}: say "rename to …", "delete claim 2", "split", "read the claims" or "start"`
        : 'Say "open …", "merge X and Y", "rename X to Y", or "start"',
    mode: "browse",
    subjectId: subject.id,
    topicId: open?.id,
    onInput: (text) => {
      const cmd = parseReviewCommand(text);
      if (!cmd) return false;
      return runCommand(cmd);
    },
  });

  // ---- render ----
  const withClaims = topics.filter((t) => t.claims.length);
  const claimCount = withClaims.reduce((s, t) => s + t.claims.length, 0);
  const firstRed = withClaims.find((t) => t.mastery === "red") ?? withClaims[0];
  const prereqNames = (id: string) => prerequisites.filter((p) => p.topic_id === id).map((p) => ({ id: p.depends_on_topic_id, name: names.get(p.depends_on_topic_id) })).filter((p): p is { id: string; name: string } => !!p.name);
  const sourceName = new Map(sources.map((s) => [s.id, s.file_name]));

  const panel = (t: ReviewTopic) => (
    <TopicPanel
      topic={t}
      canEdit={canEdit}
      busy={busy}
      prerequisites={prereqNames(t.id)}
      sourceName={sourceName}
      focusedClaim={focusedClaim}
      onFocusClaim={setFocusedClaim}
      splitMode={splitMode}
      splitIds={splitIds}
      onSplitMode={(on) => {
        setSplitMode(on);
        if (!on) setSplitIds([]);
      }}
      onToggleSplit={(id) => setSplitIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))}
      onClose={singleTopicId ? undefined : () => setOpenId(null)}
      onRename={(name) => void renameTopic(t.id, name)}
      onDelete={() => setPending({ say: `Delete ${t.name} and its ${t.claims.length} claims?`, run: () => deleteTopic(t.id) })}
      onToggleExam={() => void toggleExam(t)}
      onSplit={(name) => void splitTopic(t.id, splitIds, name)}
      onEditClaim={(cid, text) => void editClaim(t.id, cid, text)}
      onDeleteClaim={(cid) => void deleteClaim(t.id, cid)}
      onAddClaim={(text) => void addClaim(t.id, text)}
      onOpenTopic={(id) => setOpenId(id)}
    />
  );

  const banner = (
    <>
      {pending && (
        <div role="alertdialog" aria-live="assertive" className="card flex flex-wrap items-center gap-3 border-red">
          <span className="flex-1 text-sm">{pending.say.replace(/ Say yes to confirm\.$/, "")}</span>
          <button type="button" className="btn-primary" onClick={() => { void pending.run(); setPending(null); }}>
            Yes, delete
          </button>
          <button type="button" className="btn-ghost" onClick={() => setPending(null)}>
            Cancel
          </button>
        </div>
      )}
      <div aria-live="polite" className="min-h-0">
        {toast && (
          <div className={`card flex items-center gap-3 py-2 text-sm ${toast.tone === "error" ? "text-red" : ""}`}>
            <span className="flex-1">{toast.text}</span>
            {toast.undo && (
              <button type="button" className="btn-ghost py-1" onClick={() => { toast.undo?.(); setToast(null); }}>
                Undo
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );

  if (singleTopicId) {
    const t = topics.find((x) => x.id === singleTopicId);
    return (
      <div className="space-y-4">
        {banner}
        {t ? panel(t) : <EmptyState title="This topic was removed" action={{ label: `Back to ${subject.name}`, href: `/subjects/${subject.id}` }} />}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="h1 break-words">{subject.name}</h1>
            <p className="muted mt-1">
              {withClaims.length} topic{withClaims.length === 1 ? "" : "s"} · {claimCount} claims
              {subject.exam_date ? ` · exam ${new Date(subject.exam_date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}` : ""}
              {sources.length ? ` · from ${sources.length} file${sources.length === 1 ? "" : "s"}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {firstRed && (
              <Link href={`/session/${firstRed.id}`} className="btn-primary">
                Start with {firstRed.name}
              </Link>
            )}
            {canEdit && (
              <Link href={`/subjects/new?subjectId=${subject.id}`} className="btn-ghost">
                Add notes
              </Link>
            )}
            <Link href={`/graph/${subject.id}`} className="btn-ghost">
              Graph
            </Link>
          </div>
        </div>
        {canEdit && topics.length > 1 && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <button type="button" className="btn-ghost py-1" aria-pressed={selectMode} onClick={() => { setSelectMode((m) => !m); setSelected([]); }}>
              {selectMode ? "Done selecting" : "Select to merge"}
            </button>
            {selectMode && (
              <>
                <span className="muted">{selected.length} selected</span>
                <button type="button" className="btn-primary py-1" disabled={selected.length < 2 || busy} onClick={() => void mergeTopics(selected)}>
                  Merge {selected.length >= 2 ? selected.length : ""} topics
                </button>
              </>
            )}
          </div>
        )}
      </header>

      {banner}

      {topics.length === 0 ? (
        <EmptyState
          title="No topics yet"
          body="Add your notes and Samjha will find the topics and key claims in them."
          action={canEdit ? { label: "Add notes", href: `/subjects/new?subjectId=${subject.id}` } : undefined}
        />
      ) : (
        GROUPS.map((g) => {
          const list = topics.filter(g.test).sort((a, b) => a.position - b.position);
          if (!list.length) return null;
          return (
            <section key={g.key} aria-labelledby={`group-${g.key}`} className="space-y-3">
              <h2 id={`group-${g.key}`} className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
                {g.key !== "notes" && <MasteryBadge mastery={g.key as Mastery} size="sm" showLabel={false} />}
                {g.title} <span className="font-normal">({list.length})</span>
              </h2>
              {g.key === "notes" && <p className="muted -mt-1">These came from your syllabus. Add notes for each so Samjha can find what to test.</p>}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {list.map((t) => {
                  const isOpen = openId === t.id;
                  const isSel = selected.includes(t.id);
                  return (
                    <div key={t.id} id={`topic-${t.id}`} className={isOpen ? "col-span-full" : ""}>
                      {isOpen ? (
                        panel(t)
                      ) : (
                        <div className={`card relative flex h-full flex-col gap-2 border-l-4 transition hover:shadow-sm ${t.mastery === "green" ? "border-l-green" : t.mastery === "amber" ? "border-l-amber" : "border-l-red"} ${isSel ? "ring-2 ring-accent" : ""}`}>
                          <button
                            type="button"
                            className="absolute inset-0 rounded-2xl"
                            aria-label={selectMode ? `${isSel ? "Unselect" : "Select"} ${t.name}` : `Open ${t.name}`}
                            aria-pressed={selectMode ? isSel : undefined}
                            onClick={() => (selectMode ? setSelected((s) => (s.includes(t.id) ? s.filter((x) => x !== t.id) : [...s, t.id])) : setOpenId(t.id))}
                          />
                          <div className="pointer-events-none flex items-start gap-2">
                            {selectMode && (
                              <span aria-hidden className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${isSel ? "border-accent bg-accent text-accent-fg" : "border-line"}`}>
                                {isSel ? "✓" : ""}
                              </span>
                            )}
                            <h3 className="min-w-0 flex-1 break-words font-semibold">{t.name}</h3>
                            {t.in_exam ? <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs">In exam</span> : null}
                          </div>
                          <div className="pointer-events-none mt-auto flex items-center gap-2">
                            {t.claims.length ? <MasteryBadge mastery={t.mastery} size="sm" /> : <span className="text-xs text-muted">Needs notes</span>}
                            <span className="muted ml-auto text-xs">{t.claims.length} claim{t.claims.length === 1 ? "" : "s"}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })
      )}

      {sources.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Your files</h2>
          <ul className="flex flex-wrap gap-2">
            {sources.map((s) => (
              <li key={s.id}>
                <Link href={`/sources/${s.id}?page=1`} className="inline-flex max-w-full items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 text-sm hover:bg-surface-2">
                  <span className="truncate">{s.file_name}</span>
                  <span className="muted shrink-0 text-xs">{s.pages}p</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
