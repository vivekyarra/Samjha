// Heuristic "question form" of a claim, used when no AI key is set (or the AI call fails). Pure.

const VERB_BASE: Record<string, string> = {
  causes: "cause", leads: "lead", means: "mean", measures: "measure", represents: "represent", uses: "use",
  requires: "require", prevents: "prevent", reduces: "reduce", increases: "increase", decreases: "decrease",
  produces: "produce", converts: "convert", controls: "control", determines: "determine", describes: "describe",
  computes: "compute", calculates: "calculate", minimizes: "minimize", minimises: "minimise", maximizes: "maximize",
  maximises: "maximise", updates: "update", depends: "depend", contains: "contain", allows: "allow", helps: "help",
  stores: "store", returns: "return", generates: "generate", affects: "affect", improves: "improve", ensures: "ensure",
};
const PREPS = new Set(["to", "on", "of", "in", "into", "from", "for", "with"]);

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const clean = (s: string) => s.trim().replace(/\s+/g, " ").replace(/[.;:!]+$/, "");

export function heuristicQuestion(claim: string, topic?: string): string {
  const c = clean(claim);
  const words = c.split(" ");

  // "If/When X, Y" → "What happens when X?"
  const cond = /^(if|when|whenever)\s+(.{3,120}?),\s*(.+)$/i.exec(c);
  if (cond) return `What happens ${cond[1].toLowerCase() === "if" ? "if" : "when"} ${cond[2]}?`;

  // "X is/are/was Y" with a short subject → "What is X?"
  const be = /^(?!(?:if|when|whenever|because|although)\b)(.{2,80}?)\s+(is|are|was|were)\s+(?!not\b)(.+)$/i.exec(c);
  if (be && be[1].split(" ").length <= 8 && !/[,(]/.test(be[1])) {
    const subj = be[1].replace(/^(the|a|an)\s+/i, "");
    const rest = be[3];
    // "X is used to/for Y" → "What is X used for?"
    const used = /^(used|needed|required|applied)\s+(to|for)\b/i.exec(rest);
    if (used) return `What ${be[2].toLowerCase()} ${subj} ${used[1].toLowerCase()} for?`;
    if (/^(called|known as)\b/i.test(rest)) return `What ${be[2].toLowerCase()} ${subj} called?`;
    if (/^defined as\b/i.test(rest)) return `How ${be[2].toLowerCase()} ${subj} defined?`;
    return `What ${be[2].toLowerCase()} ${subj}?`;
  }

  // "X causes/leads to Y" → "What does X lead to?"
  for (let i = 1; i < Math.min(words.length - 1, 9); i++) {
    const base = VERB_BASE[words[i].toLowerCase()];
    if (!base) continue;
    const subj = words.slice(0, i).join(" ").replace(/^(the|a|an)\s+/i, "");
    if (/[,(]/.test(subj)) break;
    const prep = PREPS.has(words[i + 1]?.toLowerCase() ?? "") ? ` ${words[i + 1].toLowerCase()}` : "";
    const plural = /s$/i.test(subj.split(" ").pop() ?? "") && !/ss$/i.test(subj);
    return `What ${plural ? "do" : "does"} ${subj} ${base}${prep}?`;
  }

  const prefix = topic ? `${topic}: explain` : "Explain";
  return `${prefix} why: ${cap(c)}.`;
}

/** "(file.pdf, p.3)" citation text. */
export function citation(fileName: string | null, page: number | null): string {
  if (!fileName && !page) return "";
  return `(${[fileName, page ? `p.${page}` : null].filter(Boolean).join(", ")})`;
}
