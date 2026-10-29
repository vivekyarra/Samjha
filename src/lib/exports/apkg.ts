// Builds a real Anki .apkg (legacy collection.anki2, schema v11) with node:sqlite + jszip.
// No server-only import so it can be tested directly with tsx.
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

export interface AnkiCard { front: string; back: string; tags?: string[]; key?: string }

const ANKI_SCHEMA = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null,
  dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null,
  dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null,
  tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null,
  usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null,
  factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null,
  odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null,
  lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);
`;

export const stripHtml = (s: string) =>
  s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();

export const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Anki's checksum: first 8 hex digits of sha1(stripped first field) as an integer. */
export function fieldChecksum(field: string): number {
  return parseInt(crypto.createHash("sha1").update(stripHtml(field), "utf8").digest("hex").slice(0, 8), 16);
}

/** Stable note guid (so re-importing updates instead of duplicating). */
export function noteGuid(key: string): string {
  return crypto.createHash("sha1").update(`samjha:${key}`).digest("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 10);
}

/** Stable positive 13-digit id derived from a string (Anki ids are ms timestamps). */
function stableId(s: string): number {
  return 1_500_000_000_000 + (parseInt(crypto.createHash("sha1").update(s).digest("hex").slice(0, 10), 16) % 100_000_000_000);
}

const CSS = `.card { font-family: -apple-system, system-ui, sans-serif; font-size: 20px; text-align: left; color: #1c1b19; background: #fff; line-height: 1.45; padding: 8px; }
.cite { font-size: 14px; color: #6b6860; }
.night_mode .card { color: #eceae4; background: #1a1a18; }`;

/** Build the collection.anki2 SQLite bytes. */
export function buildCollection(deckName: string, cards: AnkiCard[], nowMs = Date.now()): Buffer {
  const tmp = path.join(os.tmpdir(), `samjha-anki-${crypto.randomUUID()}.anki2`);
  const db = new DatabaseSync(tmp);
  try {
    db.exec(ANKI_SCHEMA);
    const nowS = Math.floor(nowMs / 1000);
    const deckId = stableId(`deck:${deckName}`);
    const modelId = stableId("model:samjha-basic-v1");

    const models = {
      [modelId]: {
        id: modelId, name: "Samjha Basic", type: 0, mod: nowS, usn: -1, sortf: 0, did: deckId,
        tmpls: [{ name: "Card 1", ord: 0, qfmt: "{{Front}}", afmt: "{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}", did: null, bqfmt: "", bafmt: "" }],
        flds: [
          { name: "Front", ord: 0, sticky: false, rtl: false, font: "Arial", size: 20, media: [] },
          { name: "Back", ord: 1, sticky: false, rtl: false, font: "Arial", size: 20, media: [] },
        ],
        css: CSS,
        latexPre: "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n",
        latexPost: "\\end{document}",
        latexsvg: false,
        req: [[0, "any", [0]]],
        tags: [], vers: [],
      },
    };
    const deck = (id: number, name: string) => ({
      id, name, mod: nowS, usn: -1, desc: id === 1 ? "" : "Exported from Samjha", dyn: 0, conf: 1, collapsed: false, browserCollapsed: false,
      extendNew: 0, extendRev: 0, lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0],
    });
    const decks = { 1: deck(1, "Default"), [deckId]: deck(deckId, deckName) };
    const dconf = {
      1: {
        id: 1, name: "Default", mod: 0, usn: 0, maxTaken: 60, autoplay: true, timer: 0, replayq: true, dyn: false,
        new: { bury: true, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 7], order: 1, perDay: 20, separate: true },
        lapse: { delays: [10], leechAction: 0, leechFails: 8, minInt: 1, mult: 0 },
        rev: { bury: true, ease4: 1.3, fuzz: 0.05, ivlFct: 1, maxIvl: 36500, minSpace: 1, perDay: 200, hardFactor: 1.2 },
      },
    };
    const conf = {
      nextPos: cards.length + 1, estTimes: true, activeDecks: [deckId], sortType: "noteFld", timeLim: 0, sortBackwards: false,
      addToCur: true, curDeck: deckId, newBury: true, newSpread: 0, dueCounts: true, curModel: String(modelId), collapseTime: 1200,
    };
    const dayStart = new Date(nowMs);
    dayStart.setHours(4, 0, 0, 0);
    db.prepare("INSERT INTO col VALUES (1,?,?,?,11,0,0,0,?,?,?,?,'{}')").run(
      Math.floor(dayStart.getTime() / 1000), nowMs, nowMs, JSON.stringify(conf), JSON.stringify(models), JSON.stringify(decks), JSON.stringify(dconf),
    );

    const insNote = db.prepare("INSERT INTO notes VALUES (?,?,?,?,-1,?,?,?,?,0,'')");
    const insCard = db.prepare("INSERT INTO cards VALUES (?,?,?,0,?,-1,0,0,?,0,0,0,0,0,0,0,0,'')");
    db.exec("BEGIN");
    cards.forEach((c, i) => {
      const nid = nowMs + i;
      const cid = nowMs + cards.length + i;
      const tags = c.tags?.length ? ` ${c.tags.map((t) => t.replace(/\s+/g, "_")).join(" ")} ` : "";
      insNote.run(nid, noteGuid(c.key ?? `${deckName}:${c.front}`), modelId, nowS, tags, `${c.front}\x1f${c.back}`, stripHtml(c.front), fieldChecksum(c.front));
      insCard.run(cid, nid, deckId, nowS, i + 1);
    });
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  try {
    return fs.readFileSync(tmp);
  } finally {
    for (const f of [tmp, `${tmp}-journal`, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
  }
}

/** Zip collection + empty media map into an .apkg. */
export async function buildApkg(deckName: string, cards: AnkiCard[], nowMs = Date.now()): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("collection.anki2", buildCollection(deckName, cards, nowMs));
  zip.file("media", "{}");
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
