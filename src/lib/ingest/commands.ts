// Voice commands for reviewing topics/claims (pure; used by the subject page).

export type ReviewCommand =
  | { kind: "merge"; a?: string; b?: string; into?: string }
  | { kind: "rename"; from?: string; to: string }
  | { kind: "delete_claim"; index?: number }
  | { kind: "delete_topic"; name?: string }
  | { kind: "split"; name?: string; claims?: number[] }
  | { kind: "edit_claim"; index?: number; text: string }
  | { kind: "add_claim"; text: string }
  | { kind: "open"; name: string }
  | { kind: "select"; name: string }
  | { kind: "close" }
  | { kind: "read" }
  | { kind: "confirm" }
  | { kind: "cancel" }
  | { kind: "undo" }
  | { kind: "add_notes" }
  | { kind: "start"; name?: string };

const ORD: Record<string, number> = {
  first: 1, one: 1, "1st": 1, second: 2, two: 2, "2nd": 2, third: 3, three: 3, "3rd": 3, fourth: 4, four: 4, "4th": 4,
  fifth: 5, five: 5, "5th": 5, sixth: 6, six: 6, "6th": 6, seventh: 7, seven: 7, "7th": 7, eighth: 8, eight: 8, "8th": 8,
  ninth: 9, nine: 9, "9th": 9, tenth: 10, ten: 10, "10th": 10, eleventh: 11, twelfth: 12, last: -1,
};

function num(w: string | undefined): number | undefined {
  if (!w) return undefined;
  if (/^\d+$/.test(w)) return parseInt(w, 10);
  return ORD[w.toLowerCase()];
}

const strip = (s: string) => s.replace(/^\s*(the|a|an|topic|card)\s+/i, "").replace(/\s*(topic|card|please|for me|now)\s*$/i, "").replace(/[."'!?]+$/g, "").trim();

/** Claim numbers mentioned: "claims 2 and 3", "the first and third claim". */
function claimNumbers(s: string): number[] {
  const m = /claims?\s+((?:(?:\d+|first|second|third|fourth|fifth|sixth|seventh|eighth|last)(?:\s*,\s*|\s+and\s+|\s+)?)+)/i.exec(s) ??
    /((?:(?:first|second|third|fourth|fifth|sixth|seventh|eighth|last)(?:\s*,\s*|\s+and\s+|\s+)?)+)\s*claims?/i.exec(s);
  if (!m) return [];
  return (m[1].match(/\d+|first|second|third|fourth|fifth|sixth|seventh|eighth|last/gi) ?? []).map((w) => num(w)!).filter((n) => n !== undefined);
}

export function parseReviewCommand(input: string): ReviewCommand | null {
  const s = input.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
  if (!s || s.split(" ").length > 25) return null;
  let m: RegExpExecArray | null;

  if (/^(yes|yeah|yep|confirm|do it|go ahead|sure|ok(ay)?)$/i.test(s)) return { kind: "confirm" };
  if (/^(no|nope|cancel|never ?mind|don't|stop that)$/i.test(s)) return { kind: "cancel" };
  if (/^undo( that)?$/i.test(s)) return { kind: "undo" };

  if ((m = /^(?:merge|combine|join)(?:\s+(?:these|those|them|the two|the selected(?: topics)?|selected)(?:\s+two)?(?:\s+topics)?)?(?:\s+(?:together))?(?:\s+(?:into|as|and call it|called|named)\s+(.+))?$/i.exec(s)))
    return { kind: "merge", into: m[1] ? strip(m[1]) : undefined };
  if ((m = /^(?:merge|combine|join)\s+(.+?)\s+(?:and|with|into)\s+(.+?)(?:\s+(?:into|as|and call it|called|named)\s+(.+))?$/i.exec(s)))
    return { kind: "merge", a: strip(m[1]), b: strip(m[2]), into: m[3] ? strip(m[3]) : undefined };

  if ((m = /^(?:rename|call)\s+(?!it\b|this\b|that\b)(.+?)\s+(?:to|as|into)\s+(.+)$/i.exec(s))) return { kind: "rename", from: strip(m[1]), to: strip(m[2]) };
  if ((m = /^(?:rename(?: (?:it|this|that)(?: topic)?)?|call it|name it)\s+(?:to\s+|as\s+)?(.+)$/i.exec(s))) return { kind: "rename", to: strip(m[1]) };

  if ((m = /^(?:delete|remove|drop|get rid of)\s+(?:that|this|the)?\s*claim(?:\s+(?:number\s+)?(\w+))?$/i.exec(s))) return { kind: "delete_claim", index: num(m[1]) };
  if ((m = /^(?:delete|remove|drop)\s+(?:the\s+)?(\w+)\s+claim$/i.exec(s)) && num(m[1]) !== undefined) return { kind: "delete_claim", index: num(m[1]) };
  if (/^(?:delete|remove|drop)\s+(?:that|this|it)(?:\s+one)?$/i.test(s)) return { kind: "delete_claim" };
  if ((m = /^(?:delete|remove|drop)\s+(?:this|that|the)\s+topic$/i.exec(s))) return { kind: "delete_topic" };
  if ((m = /^(?:delete|remove|drop)\s+(?:the\s+)?topic\s+(.+)$/i.exec(s)) || (m = /^(?:delete|remove|drop)\s+(.+?)\s+topic$/i.exec(s))) return { kind: "delete_topic", name: strip(m[1]) };

  if (/^split\b/i.test(s)) {
    const claims = claimNumbers(s);
    const nm = /(?:into|as|called|named|and call it)\s+(?!claims?\b)(.+)$/i.exec(s);
    return { kind: "split", claims: claims.length ? claims : undefined, name: nm ? strip(nm[1]) : undefined };
  }

  if ((m = /^(?:change|edit|reword|rewrite|make)\s+(?:that|this|the)?\s*(?:(\w+)\s+)?claim(?:\s+(?:number\s+)?(\d+))?\s+(?:to|into|say|as)\s*:?\s+(.+)$/i.exec(s)))
    return { kind: "edit_claim", index: num(m[2]) ?? num(m[1]), text: m[3].trim() };
  if ((m = /^(?:add|new)\s+(?:a\s+)?claim\s*:?\s*(?:that\s+)?(.+)$/i.exec(s))) return { kind: "add_claim", text: m[1].trim() };

  if (/^(?:read|read out|read me)\s+(?:the\s+)?(?:claims|them|it|this)(?:\s+out)?$/i.test(s) || /^what are the claims$/i.test(s)) return { kind: "read" };
  if (/^(?:close|collapse|hide)(?:\s+(?:it|this|that|the card|topic))?$/i.test(s)) return { kind: "close" };
  if ((m = /^(?:select|pick|tick|check)\s+(.+)$/i.exec(s))) return { kind: "select", name: strip(m[1]) };
  if (/^(?:add|upload)\s+(?:more\s+)?(?:notes|files?|a file|pdf)/i.test(s)) return { kind: "add_notes" };
  if ((m = /^(?:start|let's start|begin|explain|teach back|start explaining)(?:\s+(?:with\s+)?(.+))?$/i.exec(s)) && !/^(viva|exam)/i.test(m[1] ?? ""))
    return { kind: "start", name: m[1] ? strip(m[1]) : undefined };
  if ((m = /^(?:open|show|expand)\s+(?!my\b|the graph|heatmap|settings|style)(.+)$/i.exec(s))) return { kind: "open", name: strip(m[1]) };
  return null;
}
