// Pure sentence splitting + speech cleanup shared by the speaker and by screens that highlight sentences.

const ABBR = new Set([
  "e.g", "eg", "i.e", "ie", "etc", "vs", "viz", "cf", "al", "dr", "mr", "mrs", "ms", "prof", "sr", "jr", "st",
  "fig", "figs", "eq", "eqn", "eqs", "no", "nos", "p", "pp", "pg", "ch", "chap", "sec", "vol", "approx", "ref",
  "dept", "univ", "inc", "ltd", "co", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

const CLOSERS = `"'”’)]*_`;

function isAbbreviation(before: string, next: string): boolean {
  const m = before.match(/([A-Za-z][A-Za-z.]*)$/);
  if (!m) {
    // "1. First step" at the start of a line is a list marker, not a sentence.
    return /(^|\n)\s*\d{1,3}$/.test(before);
  }
  const word = m[1].toLowerCase().replace(/\.+$/, "");
  if (word === "etc") return !/^[A-Z]/.test(next);
  if (ABBR.has(word)) return true;
  // Initials like "A. Turing" (single capital letter).
  if (/^[A-Z]$/.test(m[1]) && /^[A-Z]/.test(next)) return true;
  return false;
}

/** Split text into sentences. Handles abbreviations, decimals, list markers, Hindi danda and line breaks. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  const push = () => {
    const s = buf.trim();
    if (s) out.push(s);
    buf = "";
  };
  const t = text.replace(/\r\n?/g, "\n");
  let i = 0;
  while (i < t.length) {
    const c = t[i];
    if (c === "\n") {
      push();
      i++;
      continue;
    }
    if (c === "।" || c === "॥") {
      buf += c;
      i++;
      while (i < t.length && (t[i] === "।" || t[i] === "॥")) buf += t[i++];
      push();
      continue;
    }
    if (c === "." || c === "!" || c === "?") {
      let j = i;
      while (j < t.length && ".!?".includes(t[j])) j++;
      while (j < t.length && CLOSERS.includes(t[j])) j++;
      const run = t.slice(i, j);
      const atEnd = j >= t.length;
      const nextIsSpace = !atEnd && /\s/.test(t[j]);
      if (!atEnd && !nextIsSpace) {
        // decimals (3.14), urls, "e.g" internals
        buf += c;
        i++;
        continue;
      }
      if (!atEnd && run.replace(/[^.!?]/g, "") === ".") {
        const rest = t.slice(j).replace(/^[ \t]+/, "");
        const next = rest[0] ?? "";
        if (isAbbreviation(buf, next) || /^[a-z0-9,;:]/.test(next)) {
          buf += run;
          i = j;
          continue;
        }
      }
      buf += run;
      i = j;
      push();
      continue;
    }
    buf += c;
    i++;
  }
  push();
  return out;
}

/** Turn a displayed sentence (may contain markdown + citation links) into what should be read aloud. */
export function cleanForSpeech(s: string): string {
  return s
    .replace(/\[\s*(?:p{1,2}\.?|page)\s*[\d\s,–-]+\]\([^)]*\)/gi, "") // citation links are not read aloud
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`+/g, "")
    .replace(/\*\*|__|\*|~~/g, "")
    .replace(/(^|\s)_([^_]+)_(?=\s|$|[.,!?])/g, "$1$2")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-•+]\s+)/, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([.,!?।])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function hasDevanagari(s: string): boolean {
  return /[ऀ-ॿ]/.test(s);
}
