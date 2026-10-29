// Text helpers for the session flow: voice phrase matching, buddy text segmentation, evidence highlighting.

export const RX = {
  yes: /^(yes|yeah|yep|yup|sure|ok(ay)?|haan|ha|han|chalo|go ahead|do it|let'?s (go|do it)|please|fix (it|them|my gaps)|help me|go on|continue|carry on)\b/i,
  no: /^(no|nope|nah|not now|later|skip|nahi)\b/i,
  goOn: /\b(go on|continue|carry on|keep going|tell me more|aage)\b/i,
  explainBack: /\b(explain (it )?back|my turn|let me (try|explain)|i'?m ready|ready to explain)\b/i,
  startAgain: /\b(start (again|over)|restart|from scratch|redo)\b/i,
  retry: /\b(try again|retry|again)\b/i,
  stuck: /\b(still don'?t (get|understand)|i don'?t get it|not getting it|i'?m (still )?(lost|confused|stuck)|samajh nahi)\b/i,
  done: /^(done|finished|that'?s it|that'?s all|send|submit)\b/i,
  next: /^(next( topic)?|what'?s next|move on)\b/i,
  summary: /\b(summary|wrap up|finish|end session)\b/i,
  goBack: /\b(go back|back to|return)\b/i,
  suggest: /\bsuggest(ed|ion)?\b/i,
  why: /^(wait,? )?(but )?why\b/i,
  example: /\b(an? )?example\b/i,
  shorter: /\b(shorter|too long|tl;?dr|in short|summari[sz]e)\b/i,
  fix: /\b(fix|help|teach|explain (my )?(gaps|mistakes))\b/i,
  appeal: /\b(claim|number|point)\s*(\d+)\b.*\b(right|correct)\b/i,
  showNotes: /\b(show|open) (my )?notes\b/i,
  explainThis: /\b(explain (this|it)|start( session)?|let'?s (start|go))\b/i,
  review: /\breview\b/i,
  edit: /\bedit\b/i,
  graph: /\b(graph|why am i stuck)\b/i,
  exam: /\b(in the exam|will be in (the )?exam|flag)\b/i,
};

export const wordCount = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

const LINK_RX = /\[([^\]]*)\]\(([^)\s]+)\)|\*\*/g;

/** Strip markdown links (citations aren't read aloud) and bold markers, keeping a map back to raw indices. */
export function stripWithMap(raw: string): { text: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  let i = 0;
  LINK_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RX.exec(raw))) {
    for (let k = i; k < m.index; k++) { out.push(raw[k]); map.push(k); }
    i = m.index + m[0].length;
  }
  for (let k = i; k < raw.length; k++) { out.push(raw[k]); map.push(k); }
  map.push(raw.length);
  return { text: out.join(""), map };
}

export const toSpeech = (raw: string) => stripWithMap(raw).text.replace(/\s+/g, " ").trim();

/** Split raw (markdown) text into display segments that line up 1:1 with the speaker's sentences. */
export function segmentRaw(raw: string, sentences: string[]): string[] {
  const { text, map } = stripWithMap(raw);
  const bounds: number[] = [0];
  let cursor = 0;
  sentences.forEach((s, k) => {
    const t = s.trim();
    const at = t ? text.indexOf(t, cursor) : -1;
    if (k === 0) { if (at >= 0) cursor = at + t.length; return; }
    if (at < 0) { bounds.push(bounds[bounds.length - 1]); return; }
    bounds.push(map[at]);
    cursor = at + t.length;
  });
  bounds.push(raw.length);
  const segs: string[] = [];
  for (let k = 0; k < bounds.length - 1; k++) segs.push(raw.slice(bounds[k], Math.max(bounds[k], bounds[k + 1])));
  return segs.length ? segs : [raw];
}

/** Length of the prefix of `rest` that ends on a complete sentence (plus any trailing citation links). 0 if none yet. */
export function completeSentencePrefix(rest: string): number {
  const rx = /[.!?…]["')\]]*(?=\s)|\n/g;
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(rest))) last = m.index + m[0].length;
  if (last < 0) return 0;
  const tail = rest.slice(last).match(/^(\s*\[[^\]]*\]\([^)\s]+\))*\s*/);
  const ext = last + (tail ? tail[0].length : 0);
  // don't cut in the middle of a half-streamed link
  return ext < rest.length || /\s$/.test(rest) ? ext : last;
}

export interface Mark { start: number; end: number; kind: "covered" | "wrong"; claimNo?: number }

/** Locate evidence phrases (verbatim substrings) in the explanation; non-overlapping, sorted. */
export function findMarks(explanation: string, items: { phrase: string; kind: "covered" | "wrong"; claimNo?: number }[]): Mark[] {
  const lower = explanation.toLowerCase();
  const marks: Mark[] = [];
  for (const it of items) {
    const p = it.phrase.trim().replace(/^["“']|["”']$/g, "");
    if (p.length < 3) continue;
    let at = explanation.indexOf(p);
    if (at < 0) at = lower.indexOf(p.toLowerCase());
    if (at < 0) continue;
    const end = at + p.length;
    if (marks.some((m) => at < m.end && end > m.start)) continue;
    marks.push({ start: at, end, kind: it.kind, claimNo: it.claimNo });
  }
  return marks.sort((a, b) => a.start - b.start);
}

export const citeHref = (sourceId: string | null | undefined, page: number | null | undefined) =>
  sourceId ? `/sources/${sourceId}${page ? `?page=${page}` : ""}` : null;

/** Neutral, friendly copy for a failed request. Server error text is never shown directly. */
export function friendlyError(status: number): string {
  if (status === 429) return "Samjha is catching its breath. Give it a few seconds, then say \"try again\".";
  if (status === 401) return "You've been signed out. Sign in again to continue.";
  if (status === 403) return "This topic isn't shared with you.";
  return "That took a little longer than expected. Say \"try again\" to retry.";
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m} min ${s % 60}s` : `${s}s`;
}
