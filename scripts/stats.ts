// Prints Samjha's real-usage numbers (spec §12) from the local database.
// Run: npm run stats            (all non-guest accounts)
//      npm run stats -- you@x.com (one account)
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const dir = process.env.SAMJHA_DATA_DIR || path.join(process.cwd(), ".data");
const db = new DatabaseSync(path.join(dir, "samjha.db"), { readOnly: true });
const email = process.argv[2]?.toLowerCase();
const users = (email
  ? db.prepare("SELECT id FROM users WHERE email=?").all(email)
  : db.prepare("SELECT id FROM users WHERE is_demo=0").all()) as { id: string }[];
const ids = users.map((u) => u.id);
if (!ids.length) {
  console.log(email ? `No account for ${email}.` : "No accounts yet. Sign in at /login and start explaining.");
  process.exit(0);
}
const inList = `(${ids.map(() => "?").join(",")})`;
const one = (sql: string) => (db.prepare(sql).get(...ids) as { n: number | null }).n ?? 0;

const explanations = one(`SELECT COUNT(*) n FROM attempts WHERE user_id IN ${inList} AND kind IN ('explain','explain_back','review')`);
const words = one(`SELECT SUM(LENGTH(transcript) - LENGTH(REPLACE(transcript,' ','')) + 1) n FROM attempts WHERE user_id IN ${inList} AND transcript <> ''`);
const green = one(`SELECT COUNT(*) n FROM claim_cards WHERE user_id IN ${inList} AND mastery='green'`);
const fixed = one(`SELECT COUNT(DISTINCT cr.claim_id) n FROM claim_results cr JOIN attempts a ON a.id=cr.attempt_id
  WHERE a.user_id IN ${inList} AND a.kind='explain_back' AND cr.status='covered'`);
const topicsMastered = one(`SELECT COUNT(*) n FROM (SELECT c.topic_id, AVG(CASE WHEN cc.mastery='green' THEN 1.0 ELSE 0 END) g
  FROM claim_cards cc JOIN claims c ON c.id=cc.claim_id WHERE cc.user_id IN ${inList} GROUP BY c.topic_id) WHERE g >= 0.9`);
const days = one(`SELECT COUNT(DISTINCT substr(created_at,1,10)) n FROM attempts WHERE user_id IN ${inList}`);
const vivas = one(`SELECT COUNT(*) n FROM viva_sessions WHERE user_id IN ${inList}`);
const classmates = (db.prepare(`SELECT COUNT(DISTINCT m.user_id) n FROM subject_members m JOIN subjects s ON s.id=m.subject_id
  WHERE s.owner_id IN ${inList} AND m.role='member'`).get(...ids) as { n: number }).n;

const rows: [string, string | number][] = [
  ["Accounts", ids.length],
  ["Explanations given", explanations],
  ["Words explained out loud", words],
  ["Minutes explaining (at ~130 wpm)", Math.round(words / 130)],
  ["Claims fixed on explain-back", fixed],
  ["Claims green now", green],
  ["Topics mastered (≥90% green)", topicsMastered],
  ["Study days", days],
  ["Viva / placement sessions", vivas],
  ["Classmates who joined", classmates],
];
console.log("\n| Measure | Result |\n|---|---|");
for (const [k, v] of rows) console.log(`| ${k} | ${v} |`);
console.log();
