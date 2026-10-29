"use client";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ReactFlow, Background, Controls, Handle, Position, type Node, type Edge, type NodeProps } from "@xyflow/react";
import { MasteryBadge } from "@/components/ui/MasteryBadge";
import { useVoice, useVoiceScreen } from "@/lib/voice/context";
import type { IntentResult } from "@/lib/types";
import type { GraphView as GraphData, GraphNode, TraceResult } from "@/lib/graph";

type TraceRole = "failed" | "path" | "root" | null;
interface TopicData extends Record<string, unknown> {
  node: GraphNode;
  role: TraceRole;
  vertical: boolean;
}
type TopicNodeT = Node<TopicData, "topic">;
type Trace = TraceResult & { subjectId: string };

const STEP_MS = 400;

function TopicNode({ data }: NodeProps<TopicNodeT>) {
  const { node, role, vertical } = data;
  const ring =
    role === "failed" ? "samjha-glow border-red" : role === "root" ? "samjha-root border-accent" : role === "path" ? "border-red" : "border-line";
  return (
    <div className={`rounded-2xl border-2 bg-surface px-3 py-2 shadow-sm ${ring}`} style={{ width: vertical ? 150 : 190 }}>
      <Handle type="target" position={vertical ? Position.Top : Position.Left} className="!h-2 !w-2 !border-0 !bg-muted" />
      <div className="text-[15px] font-semibold leading-snug text-fg">{node.name}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {node.mastery === "ungraded" ? <NotTried /> : <MasteryBadge mastery={node.mastery} />}
        {node.inExam && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">In exam</span>}
      </div>
      {role === "root" && <div className="mt-1 text-xs font-medium text-accent">Root gap</div>}
      {role === "failed" && <div className="mt-1 text-xs font-medium text-red">Stuck here</div>}
      <Handle type="source" position={vertical ? Position.Bottom : Position.Right} className="!h-2 !w-2 !border-0 !bg-muted" />
    </div>
  );
}

function NotTried() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-line px-2 py-0.5 text-xs text-muted">
      <span aria-hidden>?</span> Not tried
    </span>
  );
}

const nodeTypes = { topic: TopicNode };

function useIsMobile() {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}

/** Layered layout: layer = prerequisite depth. Columns on desktop, rows on mobile. */
function layout(nodes: GraphNode[], vertical: boolean) {
  const layers = new Map<number, GraphNode[]>();
  for (const n of nodes) layers.set(n.depth, [...(layers.get(n.depth) ?? []), n]);
  const pos: Record<string, { x: number; y: number }> = {};
  const widest = Math.max(...[...layers.values()].map((l) => l.length));
  for (const [depth, list] of layers) {
    list.sort((a, b) => b.dependants - a.dependants || a.name.localeCompare(b.name));
    const offset = (widest - list.length) / 2;
    list.forEach((n, i) => {
      pos[n.id] = vertical ? { x: (i + offset) * 175, y: depth * 170 } : { x: depth * 260, y: (i + offset) * 120 };
    });
  }
  return pos;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9ऀ-ॿ ]+/g, " ").replace(/\s+/g, " ").trim();
const YES = /^(yes|yeah|yep|haan|ha|sure|ok|okay|fix it|let'?s do it|go|chalo|do it)\b/i;
const NO = /^(no|nope|nah|not now|later|nahi)\b/i;
const STUCK = /(why am i stuck|why.*stuck|stuck on|trace|root cause|what am i missing)/i;

export function GraphView({ graph, initialTrace }: { graph: GraphData; initialTrace: string | null }) {
  const router = useRouter();
  const voice = useVoice();
  const vertical = useIsMobile();
  const [trace, setTrace] = useState<Trace | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "animating" | "done" | "error">("idle");
  const [lit, setLit] = useState(0);
  const [glow, setGlow] = useState(false);
  const [error, setError] = useState("");
  const [pick, setPick] = useState(initialTrace ?? "");
  const [diagAnswer, setDiagAnswer] = useState("");
  const [diagFeedback, setDiagFeedback] = useState("");
  const [diagBusy, setDiagBusy] = useState(false);
  const timers = useRef<number[]>([]);

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  const pos = useMemo(() => layout(graph.nodes, vertical), [graph.nodes, vertical]);

  const pathEdges = useMemo(() => {
    if (!trace) return [] as string[];
    const ids: string[] = [];
    for (let i = 0; i < trace.path.length - 1; i++) ids.push(`${trace.path[i + 1]}->${trace.path[i]}`);
    return ids;
  }, [trace]);
  const litEdges = useMemo(() => new Set(pathEdges.slice(0, lit)), [pathEdges, lit]);
  const litNodes = useMemo(() => new Set(trace ? trace.path.slice(1, lit + 1) : []), [trace, lit]);

  const nodes: TopicNodeT[] = useMemo(
    () =>
      graph.nodes.map((n) => {
        let role: TraceRole = null;
        if (trace && glow && n.id === trace.path[0]) role = "failed";
        else if (trace?.root && status === "done" && n.id === trace.root.id) role = "root";
        else if (litNodes.has(n.id)) role = "path";
        return { id: n.id, type: "topic", position: pos[n.id] ?? { x: 0, y: 0 }, data: { node: n, role, vertical }, draggable: false };
      }),
    [graph.nodes, pos, trace, glow, litNodes, status, vertical],
  );
  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => {
        const on = litEdges.has(e.id);
        return {
          id: e.id, source: e.source, target: e.target, animated: on,
          style: { stroke: on ? "var(--red)" : "var(--muted)", strokeWidth: on ? 3.5 : 1.5, opacity: trace && !on ? 0.45 : 1, transition: "stroke 300ms, stroke-width 300ms" },
        };
      }),
    [graph.edges, litEdges, trace],
  );

  const clearTimers = () => { timers.current.forEach((t) => window.clearTimeout(t)); timers.current = []; };
  useEffect(() => clearTimers, []);

  const runTrace = useCallback(async (topicId: string) => {
    clearTimers();
    voice.stop();
    setStatus("loading"); setError(""); setTrace(null); setLit(0); setGlow(false); setDiagFeedback(""); setDiagAnswer("");
    try {
      const res = await fetch(`/api/graph/trace?topicId=${encodeURIComponent(topicId)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Trace failed");
      const t = body as Trace;
      setTrace(t);
      setStatus("animating");
      setGlow(true);
      const hops = t.path.length - 1;
      for (let i = 1; i <= hops; i++) timers.current.push(window.setTimeout(() => setLit(i), 700 + i * STEP_MS));
      timers.current.push(window.setTimeout(() => {
        setStatus("done");
        const q = !t.root && t.needsDiagnostic[0] ? ` ${t.needsDiagnostic[0].question}` : "";
        if (t.message) voice.speak(t.message + q);
      }, 700 + hops * STEP_MS + 250));
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Trace failed");
    }
  }, [voice]);

  const started = useRef(false);
  useEffect(() => {
    if (initialTrace && !started.current) { started.current = true; void runTrace(initialTrace); }
  }, [initialTrace, runTrace]);

  const fixRoot = useCallback(() => {
    if (!trace?.root) return;
    voice.stop();
    router.push(`/session/${trace.root.id}?returnTo=${encodeURIComponent(trace.path[0])}`);
  }, [trace, router, voice]);

  const dismiss = () => { clearTimers(); voice.stop(); setTrace(null); setStatus("idle"); setLit(0); setGlow(false); };

  const answerDiagnostic = useCallback(async (answer: string) => {
    const d = trace?.needsDiagnostic[0];
    if (!d || !answer.trim()) return;
    setDiagBusy(true);
    try {
      const res = await fetch("/api/graph/diagnostic", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topicId: d.topicId, answer }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Couldn't check that");
      setDiagFeedback(body.feedback);
      voice.speak(body.feedback);
      timers.current.push(window.setTimeout(() => void runTrace(trace!.path[0]), 1800));
    } catch (e) {
      setDiagFeedback(e instanceof Error ? e.message : "Couldn't check that");
    } finally {
      setDiagBusy(false);
    }
  }, [trace, voice, runTrace]);

  const findTopicIn = (text: string) => {
    const t = norm(text);
    let best: GraphNode | null = null;
    for (const n of graph.nodes) {
      const nn = norm(n.name);
      if (nn && t.includes(nn) && (!best || nn.length > norm(best.name).length)) best = n;
    }
    return best;
  };
  const defaultStuck = () => {
    const reds = graph.nodes.filter((n) => n.mastery === "red");
    return [...reds].sort((a, b) => b.depth - a.depth)[0] ?? graph.nodes.find((n) => n.mastery === "amber") ?? null;
  };

  const awaitingDiag = status === "done" && !!trace && !trace.root && trace.needsDiagnostic.length > 0;

  useVoiceScreen({
    hint: trace?.root && status === "done"
      ? `Say "yes" to fix ${trace.root.name} first, or "no"`
      : awaitingDiag
        ? `Answer: ${trace!.needsDiagnostic[0].question}`
        : `Say "why am I stuck on <topic>?" or "open <topic>"`,
    mode: awaitingDiag ? "explain" : "browse",
    subjectId: graph.subject.id,
    topicId: trace?.path[0],
    onInput: (text: string, intent: IntentResult) => {
      const t = text.trim();
      if (trace?.root && status === "done") {
        if (YES.test(t)) { fixRoot(); return true; }
        if (NO.test(t)) { dismiss(); voice.speak("Okay. Tap any topic to open it."); return true; }
      }
      if (STUCK.test(t)) {
        const target = findTopicIn(t) ?? (pick ? byId.get(pick) : null) ?? defaultStuck();
        if (!target) { voice.speak("Nothing looks red yet, so there's nothing to trace. Try explaining a topic first."); return true; }
        setPick(target.id);
        void runTrace(target.id);
        return true;
      }
      if (awaitingDiag && (intent.intent === "explanation" || intent.intent === "unclear")) {
        void answerDiagnostic(t);
        return true;
      }
      return false;
    },
  });

  const failedName = trace ? byId.get(trace.path[0])?.name : "";

  return (
    <div className="space-y-3">
      <style>{`
        @keyframes samjha-pulse { 0%,100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--red) 55%, transparent); } 50% { box-shadow: 0 0 0 12px color-mix(in srgb, var(--red) 0%, transparent); } }
        @keyframes samjha-root { 0%,100% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 60%, transparent); } 50% { box-shadow: 0 0 0 9px color-mix(in srgb, var(--accent) 15%, transparent); } }
        .samjha-glow { animation: samjha-pulse 1.4s ease-in-out infinite; }
        .samjha-root { animation: samjha-root 1.6s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .samjha-glow, .samjha-root { animation: none; box-shadow: 0 0 0 4px var(--red); } }
        .react-flow__node.selected > div, .react-flow__node:focus-visible > div { outline: 2px solid var(--accent); outline-offset: 2px; }
      `}</style>

      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="h1">{graph.subject.name}</h1>
          <p className="muted">Arrows point from what you need first to what builds on it. Tap a topic to open it.</p>
        </div>
        <Link href={`/exam-eve?subjectId=${graph.subject.id}`} className="btn-ghost">Exam-eve mode</Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <MasteryBadge mastery="red" />
        <MasteryBadge mastery="amber" />
        <MasteryBadge mastery="green" />
        <NotTried />
      </div>

      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => { e.preventDefault(); if (pick) void runTrace(pick); }}
      >
        <label className="sr-only" htmlFor="stuck-topic">Topic you&apos;re stuck on</label>
        <select id="stuck-topic" className="input sm:max-w-xs" value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">Pick the topic you&apos;re stuck on…</option>
          {graph.nodes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
        </select>
        <button className="btn-primary" disabled={!pick || status === "loading" || status === "animating"}>
          {status === "loading" ? "Tracing…" : "Why am I stuck?"}
        </button>
      </form>

      {status === "error" && (
        <div className="card flex items-center justify-between gap-3 border-red">
          <p className="text-sm">{error}</p>
          <button className="btn-ghost" onClick={() => pick && runTrace(pick)}>Retry</button>
        </div>
      )}

      {trace && status === "done" && (
        <div className="card space-y-3 border-2 border-accent" role="status" aria-live="polite">
          <p className="text-lg leading-relaxed">{trace.message}</p>
          {trace.root ? (
            <div className="flex flex-wrap gap-2">
              <button className="btn-primary" onClick={fixRoot}>Yes, fix {trace.root.name} first</button>
              <button className="btn-ghost" onClick={dismiss}>Not now</button>
              <Link className="btn-ghost" href={`/session/${trace.path[0]}`}>Retry {failedName}</Link>
            </div>
          ) : awaitingDiag ? (
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void answerDiagnostic(diagAnswer); }}>
              <p className="font-medium">{trace.needsDiagnostic[0].question}</p>
              <input className="input" value={diagAnswer} onChange={(e) => setDiagAnswer(e.target.value)} placeholder="Say or type a one-line answer" />
              <div className="flex flex-wrap items-center gap-2">
                <button className="btn-primary" disabled={diagBusy || !diagAnswer.trim()}>{diagBusy ? "Checking…" : "Check"}</button>
                <button type="button" className="btn-ghost" onClick={dismiss}>Cancel</button>
                {diagFeedback && <span className="text-sm">{diagFeedback}</span>}
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Link className="btn-primary" href={`/session/${trace.path[0]}`}>Go through {failedName} again</Link>
              <button className="btn-ghost" onClick={dismiss}>Close</button>
            </div>
          )}
        </div>
      )}

      <div className="h-[62vh] min-h-[420px] overflow-hidden rounded-2xl border border-line bg-surface-2">
        <ReactFlow
          key={vertical ? "v" : "h"}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }}
          minZoom={0.3}
          nodesDraggable={false}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          colorMode="system"
          onNodeClick={(_, n) => router.push(`/topics/${n.id}`)}
        >
          <Background gap={24} color="var(--line)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {graph.edges.length === 0 && (
        <p className="muted">No prerequisite links found yet. Add them from the subject page so root-cause tracing can work.</p>
      )}
    </div>
  );
}
