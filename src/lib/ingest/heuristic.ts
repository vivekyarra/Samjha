// Local extractor (no AI): headings → topics, testable declarative sentences → claims, mentions → prerequisites.
import { cosine, embed } from "./embed";
import { isGenericName } from "./fuzzy";
import { cleanTopicName, normName, splitSentences, STOPWORDS, titleCase, tokenize, wordCount, words, type PageText } from "./text";

export interface ExtractedClaim { text: string; page: number }
export interface ExtractedTopic { name: string; claims: ExtractedClaim[]; prerequisites: string[] }
export interface Extraction { topics: ExtractedTopic[] }

interface Line { text: string; page: number; blankBefore: boolean; firstOnPage: boolean }
interface Heading { idx: number; level: number; name: string; generic: boolean }
interface Unit { text: string; spans: { offset: number; page: number }[]; bullet: boolean; example: boolean }
interface Section { name: string; units: Unit[]; order: number }

const BULLET = /^(?:[-*•●○▪■◦‣►▸✓✔–—>]|\(?[a-z][.)]|\(?[ivx]{1,4}\))\s+/i;
const NUMBERED = /^(\d{1,2}(?:\.\d{1,2}){0,3})[.)]?\s+(.+)$/;
const PREFIXED = /^(chapter|lecture|unit|module|week|part|section|topic|lesson)\s*([\divxlc]+(?:\.\d+)*)?\s*[.:\-–—)]*\s*(.*)$/i;
const VERBISH = /\b(is|are|was|were|be|has|have|had|can|cannot|will|would|should|must|does|do|did|means|uses|gives|takes|makes|becomes|occurs|refers)\b/i;
const GENERIC_HEADING = /^(summary|overview|outline|agenda|contents|table of contents|references|bibliography|further reading|reading|questions?|q ?& ?a|examples?|worked examples?|exercises?|practice( problems)?|homework|notes?|key (points|ideas|takeaways)|takeaways|recap|review|learning (objectives|outcomes)|objectives|goals|definitions?|note|remember|important|figure.*|today|announcements?|acknowledg(e)?ments?|appendix.*|thank you|thanks|introduction|intro|conclusions?)$/i;
const SKIP_HEADING = /^(summary|overview|outline|agenda|contents|table of contents|references|bibliography|further reading|reading( list)?|questions?|q ?& ?a|homework|recap|review|learning (objectives|outcomes)|objectives|goals|today|announcements?|acknowledg(e)?ments?|appendix.*|thank you|thanks|conclusions?)$/i;
const EXAMPLE_HEADING =/^(examples?|worked examples?|exercises?|practice.*|homework|questions?)$/i;

const DEF_CUE = /\b(is|are) (a|an|the|defined|called|known|used|equal|proportional|given|computed|measured)\b|\brefers? to\b|\bmeans?\b|\bdenotes?\b|\bis when\b|\bdescribes?\b/i;
const VERB_CUE = /\b(is|are|was|were|has|have|uses?|computes?|calculates?|causes?|leads? to|requires?|depends? on|allows?|gives?|returns?|reduces?|increases?|decreases?|measures?|represents?|consists? of|contains?|produces?|prevents?|ensures?|converges?|diverges?|updates?|minimi[sz]es?|maximi[sz]es?|can|cannot|must|will|should|occurs?|results? in|determines?|controls?|helps?|makes?|becomes?|provides?|stores?|maps?|takes?|moves?|changes?|equals?|depends|implies|states?|follows?|applies|work(s)?|happens?|acts?|converts?|transfers?|releases?|absorbs?|forms?|splits?|combines?|generali[sz]es?|learns?|predicts?|estimates?|approximates?|penali[sz]es?|adds?|multiplies|divides?|repeats?|stops?|starts?)\b|=|→|->|⇒|∝/i;
const LOGISTICS = /\b(today|this lecture|next (week|class|lecture|time)|homework|assignment|quiz|deadline|due date|office hours|slides?|textbook|chapter \d|page \d|see (figure|fig|table|section)|click|website|email|piazza|canvas|moodle)\b/i;
const PERSONAL = /\b(i|we|our|us|you|your|let's)\b/i;
const PRONOUN_START = /^(this|it|these|they|that|those|such|he|she|its|their|here|there)\b/i;
const TRANSITION = /^(however|also|so|thus|therefore|hence|moreover|furthermore|in addition|additionally|similarly|likewise|note that|remember that|recall that|importantly|basically|in other words|in short|in summary|finally|first|second|third|then|next)\s*,?\s+/i;
const EXAMPLE_START = /^(for example|for instance|e\.g\.|eg|example|ex\.|consider|suppose|imagine|let)\b/i;
const LABEL_PREFIX = /^(note|nb|n\.b\.|key point|key idea|important|remember|tip|def|definition|fact|rule|law|theorem|principle|property|claim|result|insight|idea|summary|recall|takeaway)\s*[:\-–—]\s*/i;

function isPageNumber(t: string) {
  return /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(t) || /^[-–—\s]*\d{1,4}[-–—\s]*$/.test(t);
}

function buildLines(pages: PageText[]): Line[] {
  const perPage = pages.map((p) => ({ page: p.page, lines: (p.marked ?? p.text).split("\n") }));
  // repeated headers/footers: same line (digits stripped) at top/bottom of most pages
  const edgeCount = new Map<string, number>();
  if (pages.length >= 4) {
    for (const p of perPage) {
      const ne = p.lines.map((l) => l.trim()).filter(Boolean);
      const edges = new Set([...ne.slice(0, 2), ...ne.slice(-2)].map((l) => l.replace(/^#+\s*/, "").replace(/\d+/g, "#").toLowerCase()));
      for (const e of edges) edgeCount.set(e, (edgeCount.get(e) ?? 0) + 1);
    }
  }
  const minRepeats = Math.max(4, Math.ceil(pages.length * 0.6));
  const out: Line[] = [];
  for (const p of perPage) {
    let blank = true, first = true;
    for (const rawLine of p.lines) {
      const t = rawLine.trim();
      if (!t) {
        blank = true;
        continue;
      }
      const key = t.replace(/^#+\s*/, "").replace(/\d+/g, "#").toLowerCase();
      if (isPageNumber(t) || (pages.length >= 4 && (edgeCount.get(key) ?? 0) >= minRepeats && wordCount(t) <= 12)) continue;
      out.push({ text: t, page: p.page, blankBefore: blank, firstOnPage: first });
      blank = false;
      first = false;
    }
  }
  return out;
}

function capRatio(text: string): number {
  const ws = text.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w) && !STOPWORDS.has(w.toLowerCase()));
  if (!ws.length) return 0;
  return ws.filter((w) => /^[A-Z]/.test(w)).length / ws.length;
}

function classify(lines: Line[], i: number): { level: number; name: string } | null {
  const l = lines[i];
  const t = l.text;
  const md = /^(#{1,6})\s+(.+)$/.exec(t);
  if (md) return { level: md[1].length, name: md[2] };
  if (BULLET.test(t) && !NUMBERED.test(t)) return null;
  const wc = wordCount(t);
  if (wc > 12 || t.length > 90) return null;
  const prev = lines[i - 1], next = lines[i + 1];
  const standalone = l.blankBefore || l.firstOnPage || !prev || /[.!?:;]$/.test(prev.text) || wordCount(prev.text) <= 8;
  if (/[.,;!?]$/.test(t) || /["“]$/.test(t)) return null;
  const pre = PREFIXED.exec(t);
  if (pre && (pre[2] || pre[3])) {
    const rest = pre[3]?.trim();
    if (!rest || wordCount(rest) > 10) return { level: 0, name: t };
    const depth = pre[2] ? pre[2].split(".").length : 1;
    return { level: depth - 1, name: rest };
  }
  const num = NUMBERED.exec(t);
  if (num) {
    const rest = num[2].trim();
    const depth = num[1].split(".").length;
    if (!/^[A-Z]/.test(rest) || wordCount(rest) > 9 || / (is|are|was|were) /.test(rest)) return null;
    // "1. Compute the gradient" followed by "2. ..." is a list, not a heading
    const nextIsSibling = next && NUMBERED.test(next.text) && NUMBERED.exec(next.text)![1].split(".").length === depth;
    if (depth === 1 && nextIsSibling && !l.blankBefore) return null;
    if (depth === 1 && !next) return null;
    return { level: depth, name: rest };
  }
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 3 && letters.replace(/[^A-Z]/g, "").length / letters.length >= 0.8 && wc <= 8 && (standalone || l.firstOnPage)) {
    if (letters.length <= 4 && wc === 1 && !l.blankBefore && !l.firstOnPage) return null;
    return { level: 1, name: t };
  }
  if (!/^[A-Z]/.test(t) || wc > 7 || t.length > 64) return null;
  if (!standalone) return null;
  const tail = words(t).at(-1) ?? "";
  if (STOPWORDS.has(tail) && !/^(it|this)$/.test(tail)) return null;
  if (VERBISH.test(t.replace(/:$/, ""))) return null;
  if (/\d{3,}/.test(t) || /[=<>+]/.test(t)) return null;
  const body = next && !classifySimple(next.text);
  const caps = capRatio(t);
  const titleish = caps >= 0.6 || wc <= 3;
  if (!titleish && !l.firstOnPage) return null;
  if (!body && !l.firstOnPage && !t.endsWith(":")) return null;
  if (next && next.page === l.page && wordCount(next.text) <= wc && !BULLET.test(next.text) && !l.firstOnPage && !l.blankBefore) return null;
  return { level: 2, name: t };
}

function markdownHeading(t: string): { level: number; name: string } | null {
  const md = /^(#{1,6})\s+(.+)$/.exec(t);
  return md ? { level: md[1].length, name: md[2] } : null;
}

function classifySimple(t: string): boolean {
  return /^#{1,6}\s/.test(t);
}

function detectHeadings(lines: Line[]): Heading[] {
  const hs: Heading[] = [];
  // explicit markers (markdown or font-size derived) are authoritative when present
  const mdOnly = lines.filter((l) => /^#{1,6}\s/.test(l.text)).length >= 2;
  for (let i = 0; i < lines.length; i++) {
    const c = mdOnly ? markdownHeading(lines[i].text) : classify(lines, i);
    if (!c) continue;
    const name = cleanTopicName(c.name);
    if (!name || name.length < 2 || !/[A-Za-z]{2}/.test(name)) continue;
    const generic = GENERIC_HEADING.test(name.trim()) || isGenericName(name);
    hs.push({ idx: i, level: c.level, name, generic });
  }
  // merge a heading split over two lines (same level, adjacent, no body between)
  const merged: Heading[] = [];
  for (const h of hs) {
    const prev = merged.at(-1);
    if (prev && h.idx === prev.idx + 1 && h.level === prev.level && lines[h.idx].page === lines[prev.idx].page && /^#/.test(lines[h.idx].text) && wordCount(prev.name + " " + h.name) <= 10) {
      prev.name = cleanTopicName(prev.name + " " + h.name);
      prev.idx = h.idx;
      prev.generic = GENERIC_HEADING.test(prev.name) || isGenericName(prev.name);
      continue;
    }
    merged.push({ ...h });
  }
  return merged;
}

function chooseTopicLevel(hs: Heading[], lines: Line[]): number | null {
  const real = hs.filter((h) => !h.generic);
  const counts = new Map<number, number>();
  for (const h of real) counts.set(h.level, (counts.get(h.level) ?? 0) + 1);
  const levels = [...counts.keys()].filter((l) => (counts.get(l) ?? 0) >= 2).sort((a, b) => a - b);
  if (!levels.length) return real.length === 1 ? real[0].level : null;
  const totalChars = lines.reduce((s, l) => s + l.text.length, 0);
  for (const L of levels) {
    const avg = totalChars / ((counts.get(L) ?? 1) + 1);
    if (avg <= 5000) return L;
  }
  return levels.at(-1)!;
}

function buildUnits(lines: Line[], from: number, to: number, startInExample = false): Unit[] {
  const units: Unit[] = [];
  let cur: Unit | null = null;
  let inExample = startInExample;
  for (let i = from; i < to; i++) {
    const l = lines[i];
    const md = /^#{1,6}\s+(.+)$/.exec(l.text);
    if (md) {
      // a sub-heading inside this topic: closes the current unit
      inExample = EXAMPLE_HEADING.test(cleanTopicName(md[1]));
      cur = null;
      continue;
    }
    const bullet = BULLET.test(l.text) || NUMBERED.test(l.text);
    const text = l.text.replace(BULLET, "").replace(/^\d{1,2}[.)]\s+/, "");
    const prevLine = i > from ? lines[i - 1] : null;
    const join =
      cur &&
      !bullet &&
      !(cur.bullet && /^[A-Z]/.test(text)) &&
      !l.blankBefore &&
      prevLine &&
      !/[.!?:;]$/.test(prevLine.text) &&
      (prevLine.text.length >= 60 || /[,\-–(]$/.test(prevLine.text) || STOPWORDS.has(words(prevLine.text).at(-1) ?? "") || /^[a-z(]/.test(text));
    if (join && cur) {
      cur.spans.push({ offset: cur.text.length + 1, page: l.page });
      cur.text += " " + text;
    } else {
      if (/^(examples?|e\.g\.|for example)\s*:?$/i.test(text)) inExample = true;
      cur = { text, spans: [{ offset: 0, page: l.page }], bullet, example: inExample };
      units.push(cur);
    }
  }
  return units;
}

function pageAt(u: Unit, offset: number): number {
  let p = u.spans[0].page;
  for (const s of u.spans) if (s.offset <= offset) p = s.page;
  return p;
}

/** Turn "Learning rate: the step size" into a sentence; strip labels and bullets; end with a period. */
export function cleanClaim(raw: string): string {
  let s = raw.replace(/\s+/g, " ").trim().replace(BULLET, "").replace(/^\*\*|\*\*$/g, "").replace(/\*\*/g, "").replace(/`/g, "");
  s = s.replace(LABEL_PREFIX, "");
  s = s.replace(TRANSITION, "");
  const def = /^([A-Za-z][\w\s()'/-]{1,40}?)\s*(?::|\s[-–—]\s)\s*(.{8,})$/.exec(s);
  if (def && wordCount(def[1]) <= 5 && !VERBISH.test(def[1])) {
    const rhs = def[2].trim();
    const fw = words(rhs)[0] ?? "";
    if (/^(is|are|was|were|uses?|means?|refers?|computes?|measures?|gives?|controls?|determines?|represents?|describes?|can|has|have)$/.test(fw)) s = `${def[1]} ${rhs}`;
    else if (/^(a|an|the|one|any|how|when|where|why|what|which|used|computed|measured|defined)$/.test(fw) || /^[a-z]/.test(rhs)) s = `${def[1]} is ${rhs.replace(/^(a|an|the)\b/i, (m) => m.toLowerCase())}`;
  }
  s = s.replace(/\s*[;:,]+$/, "").trim();
  if (!s) return "";
  s = s[0].toUpperCase() + s.slice(1);
  if (!/[.!?)]$/.test(s)) s += ".";
  return s;
}

interface Candidate { text: string; page: number; score: number; order: number }

function scoreCandidates(sec: Section, keywords: Map<string, number>): Candidate[] {
  const nameToks = new Set(tokenize(sec.name));
  const out: Candidate[] = [];
  let order = 0;
  for (const u of sec.units) {
    const sents = u.bullet && !/[.!?]\s+[A-Z]/.test(u.text) ? [u.text] : splitSentences(u.text);
    let searchFrom = 0;
    for (const raw of sents) {
      const at = u.text.indexOf(raw.slice(0, 20), searchFrom);
      const page = pageAt(u, at >= 0 ? at : 0);
      if (at >= 0) searchFrom = at + 1;
      order++;
      const orig = raw.trim();
      if (/\?\s*$/.test(orig) || /https?:\/\/|www\./i.test(orig)) continue;
      const text = cleanClaim(orig);
      const wc = wordCount(text);
      if (wc < 4 || wc > 45) continue;
      const toks = tokenize(text);
      if (toks.length < 3) continue;
      const numeric = toks.filter((t) => /^\d/.test(t)).length / toks.length;
      let score = 0;
      if (DEF_CUE.test(text)) score += 2;
      if (VERB_CUE.test(text)) score += 1;
      else score -= u.bullet ? 1 : 2.5;
      if (toks.some((t) => nameToks.has(t))) score += 1;
      const kw = toks.reduce((s, t) => s + (keywords.get(t) ?? 0), 0) / Math.sqrt(toks.length);
      score += Math.min(2, kw);
      if (wc >= 7 && wc <= 30) score += 1;
      if (LOGISTICS.test(text)) score -= 3;
      if (PERSONAL.test(text)) score -= 0.75;
      if (PRONOUN_START.test(text) && !toks.some((t) => nameToks.has(t))) score -= 1.5;
      if (EXAMPLE_START.test(orig) || u.example) score -= 2.5;
      if (/^(therefore|thus|hence|so)\b/i.test(orig)) score -= 0.5;
      if (numeric > 0.3) score -= 1;
      if (/^[^A-Za-z]/.test(text)) score -= 1;
      out.push({ text, page, score, order });
    }
  }
  return out;
}

function pickClaims(cands: Candidate[]): ExtractedClaim[] {
  const sorted = [...cands].sort((a, b) => b.score - a.score || a.order - b.order);
  const chosen: (Candidate & { vec: number[] })[] = [];
  for (const c of sorted) {
    if (chosen.length >= 8) break;
    const min = chosen.length < 3 ? 0 : 1.5;
    if (c.score < min) break;
    const vec = embed(c.text);
    if (chosen.some((x) => cosine(x.vec, vec) >= 0.86)) continue;
    chosen.push({ ...c, vec });
  }
  return chosen.sort((a, b) => a.order - b.order).map((c) => ({ text: c.text, page: c.page }));
}

/** Section keyword weights: frequent in this section, rarer elsewhere. */
function sectionKeywords(sections: Section[]): Map<string, number>[] {
  const tfs = sections.map((s) => {
    const m = new Map<string, number>();
    for (const u of s.units) for (const t of tokenize(u.text)) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  });
  const df = new Map<string, number>();
  for (const m of tfs) for (const k of m.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  const N = sections.length;
  return tfs.map((m) => {
    const w = new Map<string, number>();
    for (const [k, n] of m) if (n >= 2) w.set(k, Math.log(1 + n) * Math.log(1 + N / (df.get(k) ?? 1)) * 0.5);
    return w;
  });
}

/** Best 1–3 word key phrase for a block of text (used when the notes have no headings). */
function keyPhrase(units: Unit[], others: Unit[][]): string | null {
  const count = (us: Unit[]) => {
    const m = new Map<string, { n: number; surface: string }>();
    for (const u of us) {
      const ws = u.text.match(/[A-Za-z][A-Za-z0-9'-]*/g) ?? [];
      for (let len = 1; len <= 3; len++) {
        for (let i = 0; i + len <= ws.length; i++) {
          const g = ws.slice(i, i + len);
          if (STOPWORDS.has(g[0].toLowerCase()) || STOPWORDS.has(g[len - 1].toLowerCase())) continue;
          if (g.some((w) => w.length < 3 && w.toUpperCase() !== w)) continue;
          const key = tokenize(g.join(" ")).join(" ");
          if (!key || key.split(" ").length !== len) continue;
          const e = m.get(key) ?? { n: 0, surface: g.join(" ") };
          e.n++;
          m.set(key, e);
        }
      }
    }
    return m;
  };
  const mine = count(units);
  const rest = others.map(count);
  let best: { s: number; surface: string } | null = null;
  for (const [k, { n, surface }] of mine) {
    if (n < 2 || isGenericName(surface) || VERBISH.test(surface)) continue;
    const len = k.split(" ").length;
    const df = rest.filter((r) => r.has(k)).length;
    const s = n * (len === 1 ? 1 : len === 2 ? 2.2 : 2.6) / (1 + df);
    if (!best || s > best.s) best = { s, surface };
  }
  return best ? titleCase(best.surface.toLowerCase(), true) : null;
}

/** The term defined by the opening sentence ("Photosynthesis is the process…"), if any. */
function definedTerm(units: Unit[]): string | null {
  const first = splitSentences(units.slice(0, 2).map((u) => u.text).join(" "))[0] ?? "";
  const m = /^(?:the\s+)?([A-Z][\w'-]*(?:\s+[\w'-]+){0,3}?)\s+(?:is|are|refers to|means|describes)\s+(?:the|a|an|when|how)\b/i.exec(first);
  if (!m || isGenericName(m[1]) || PRONOUN_START.test(m[1])) return null;
  return titleCase(m[1].toLowerCase(), true);
}

function segmentWithoutHeadings(lines: Line[], defaultName: string): Section[] {
  const units = buildUnits(lines, 0, lines.length);
  const total = units.reduce((s, u) => s + u.text.length, 0);
  const groups: Unit[][] = [];
  if (total <= 2500) groups.push(units);
  else {
    const target = Math.min(2500, Math.max(1500, total / 12));
    let cur: Unit[] = [], size = 0;
    for (const u of units) {
      cur.push(u);
      size += u.text.length;
      if (size >= target) {
        groups.push(cur);
        cur = [];
        size = 0;
      }
    }
    if (cur.length) {
      if (size < 600 && groups.length) groups[groups.length - 1].push(...cur);
      else groups.push(cur);
    }
  }
  const sections: Section[] = groups.map((g, i) => ({
    name: definedTerm(g) ?? keyPhrase(g, groups.filter((_, j) => j !== i)) ??(groups.length === 1 ? defaultName : `${defaultName} (part ${i + 1})`),
    units: g,
    order: i,
  }));
  // adjacent segments with the same name are one topic
  const merged: Section[] = [];
  for (const s of sections) {
    const prev = merged.at(-1);
    if (prev && normName(prev.name) === normName(s.name)) prev.units.push(...s.units);
    else merged.push(s);
  }
  return merged;
}

function buildSections(lines: Line[], defaultName: string): Section[] {
  const hs = detectHeadings(lines);
  const level = chooseTopicLevel(hs, lines);
  if (level === null) return segmentWithoutHeadings(lines, defaultName);
  const topicHs = hs.filter((h) => h.level === level && !h.generic);
  const sections: Section[] = [];
  const firstIdx = topicHs[0]?.idx ?? lines.length;
  // preamble before the first topic heading
  if (firstIdx > 0) {
    const preLines = lines.slice(0, firstIdx).filter((_, i) => !hs.some((h) => h.idx === i));
    const pre = buildUnits(preLines, 0, preLines.length);
    const chars = pre.reduce((s, u) => s + u.text.length, 0);
    if (chars >= 300) {
      const title = hs.find((h) => h.idx < firstIdx && !h.generic && h.level < level);
      sections.push({ name: title?.name ?? keyPhrase(pre, []) ?? defaultName, units: pre, order: 0 });
    }
  }
  topicHs.forEach((h, k) => {
    const end = k + 1 < topicHs.length ? topicHs[k + 1].idx : lines.length;
    // shallower headings (unit/chapter labels) inside the range end the section body there
    // so do "Summary"/"References"-style headings at topic level (their content is not a topic's)
    const stop = hs.find((x) => x.idx > h.idx && x.idx < end && ((x.level < level && !x.generic) || (x.level <= level && SKIP_HEADING.test(x.name))))?.idx ?? end;
    const sub = lines.slice(h.idx + 1, stop).map((l, i) => {
      const abs = h.idx + 1 + i;
      const hh = hs.find((x) => x.idx === abs);
      return hh ? { ...l, text: `### ${hh.name}` } : l;
    });
    sections.push({ name: h.name, units: buildUnits(sub, 0, sub.length), order: sections.length });
  });
  // same heading repeated (e.g. slide titles across pages) → one section
  const byName = new Map<string, Section>();
  const out: Section[] = [];
  for (const s of sections) {
    const key = normName(s.name);
    const ex = byName.get(key);
    if (ex) ex.units.push(...s.units);
    else {
      byName.set(key, s);
      out.push(s);
    }
  }
  return out;
}

function phraseIn(hay: string[], needle: string[]): number {
  if (!needle.length || needle.length > hay.length) return 0;
  let n = 0;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) { ok = false; break; }
    if (ok) n++;
  }
  return n;
}

/** Prerequisites by mention: topic A depends on B if A's text mentions B and B came earlier (or A's name contains B's). */
export function inferPrerequisites(topics: { name: string; text: string }[]): string[][] {
  const names = topics.map((t) => tokenize(t.name));
  const bodies = topics.map((t) => tokenize(t.text));
  return topics.map((a, i) => {
    const scored: { name: string; n: number }[] = [];
    topics.forEach((b, j) => {
      if (i === j || isGenericName(b.name) || names[j].join(" ").length < 4) return;
      if (normName(a.name) === normName(b.name)) return;
      const contained = names[j].length < names[i].length && phraseIn(names[i], names[j]) > 0;
      const mentions = phraseIn(bodies[i], names[j]);
      if (contained || (mentions >= 1 && j < i) || mentions >= 3) scored.push({ name: b.name, n: mentions + (contained ? 5 : 0) });
    });
    return scored.sort((x, y) => y.n - x.n).slice(0, 3).map((s) => s.name);
  });
}

export interface LocalExtractOptions {
  /** Used to name a topic when the notes have no headings. */
  defaultName?: string;
  /** Put everything into one topic with this name (notes added for a specific topic). */
  singleTopic?: string;
}

/** Extract topics + claims + prerequisites from page texts without any AI. */
export function localExtract(pages: PageText[], opts: LocalExtractOptions = {}): Extraction {
  const lines = buildLines(pages);
  if (!lines.length) return { topics: [] };
  const baseName = cleanTopicName(opts.defaultName?.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[_-]+/g, " ") || "Notes") || "Notes";
  let sections = opts.singleTopic ? [{ name: opts.singleTopic, units: buildUnits(lines, 0, lines.length), order: 0 }] : buildSections(lines, baseName);
  if (!sections.length) sections = segmentWithoutHeadings(lines, baseName);
  const kws = sectionKeywords(sections);
  let topics = sections.map((s, i) => ({
    name: s.name,
    claims: pickClaims(scoreCandidates(s, kws[i])),
    text: s.units.map((u) => u.text).join(" "),
  }));
  if (opts.singleTopic) {
    // a single topic may hold more material: allow the best 8 overall
    topics = topics.slice(0, 1);
  } else {
    // tiny topics (≤1 claim) fold into the previous topic when it has room; empty ones are dropped
    const folded: typeof topics = [];
    for (const t of topics) {
      const prev = folded.at(-1);
      if (t.claims.length <= 1 && prev && prev.claims.length + t.claims.length <= 8) {
        prev.claims.push(...t.claims);
        prev.text += " " + t.text;
        continue;
      }
      if (t.claims.length === 0) continue;
      folded.push(t);
    }
    topics = folded;
  }
  const prereqs = inferPrerequisites(topics);
  return { topics: topics.map((t, i) => ({ name: t.name, claims: t.claims, prerequisites: prereqs[i] })) };
}

/** Topic names from a syllabus outline. */
export function parseSyllabus(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const name = cleanTopicName(raw.replace(BULLET, "").replace(/\s*\(\d+\s*(hrs?|hours?|lectures?|weeks?|marks?)\)\s*$/i, ""));
    const key = normName(name);
    if (!key || name.length < 3 || name.length > 80 || wordCount(name) > 10 || seen.has(key)) return;
    if (/^(syllabus|course (outline|syllabus|content)|topics?|contents|schedule|week|unit|module|grading|assessment|textbooks?|references?)$/i.test(name)) return;
    if (/\b(marks|grading|attendance|exam on|midterm|final exam|office hours|prerequisite course)\b/i.test(name)) return;
    seen.add(key);
    out.push(name);
  };
  for (const rawLine of text.replace(/\r/g, "").split(/\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    line = line.replace(BULLET, "").replace(/^#+\s*/, "");
    // "Unit 2: Optimisation — Gradient descent, SGD, Momentum"
    const head = /^(.{2,60}?)\s*[:\-–—]\s+(.+)$/.exec(line);
    const listy = (s: string) => /[,;]/.test(s) && s.split(/[,;]/).every((p) => wordCount(p) <= 6);
    const listPart = line.split(/\s*[:–—]\s+|\s+-\s+/).at(-1) ?? "";
    if (head && listy(listPart)) {
      for (const p of listPart.split(/[,;]/)) push(p);
      continue;
    }
    if (listy(line) && line.split(/[,;]/).length >= 3) {
      for (const p of line.split(/[,;]/)) push(p);
      continue;
    }
    if (head && PREFIXED.test(line)) {
      push(head[2]);
      continue;
    }
    if (wordCount(line) <= 10 && !/[.?!]$/.test(line)) push(line);
  }
  return out;
}
