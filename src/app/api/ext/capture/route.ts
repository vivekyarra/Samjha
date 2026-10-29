// POST /api/ext/capture {text?, url, title, subjectId?, pdfUrl?, pdfBase64?}
// Turns a browser selection (or a whole PDF) into a Samjha source + topic and returns where to explain it.
import dns from "node:dns/promises";
import net from "node:net";
import { z } from "zod";
import { all, get, logEvent } from "@/lib/db";
import { canAccessSubject } from "@/lib/auth";
import { enforceAiLimit } from "@/lib/ratelimit";
import { createSubject, ingestSource } from "@/lib/ingest";
import type { Subject, Topic } from "@/lib/types";
import { badRequest, extHandler, preflight, requireExtUser } from "../_shared";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const OPTIONS = preflight;

const MAX_PDF = 20 * 1024 * 1024;
const WEB_SUBJECT = "From the web";

const Body = z.object({
  text: z.string().max(200_000).optional(),
  url: z.string().max(4000).optional().default(""),
  title: z.string().max(300).optional().default(""),
  subjectId: z.string().max(64).optional(),
  pdfUrl: z.string().max(4000).optional(),
  pdfBase64: z.string().max(Math.ceil((MAX_PDF * 4) / 3) + 16).optional(),
});

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw badRequest("That PDF link doesn't look valid."); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw badRequest("Only http(s) PDFs can be fetched. Select some text instead.");
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw badRequest("Samjha can't fetch PDFs from that address. Select the text instead.");
  return u;
}

async function fetchPdf(raw: string): Promise<Buffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    let url = await assertPublicUrl(raw);
    for (let hop = 0; hop < 4; hop++) {
      const res = await fetch(url, { signal: ctrl.signal, redirect: "manual", headers: { accept: "application/pdf,*/*" } });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        url = await assertPublicUrl(new URL(res.headers.get("location")!, url).toString());
        continue;
      }
      if (!res.ok || !res.body) throw badRequest(`Couldn't download the PDF (HTTP ${res.status}). Select some text instead.`);
      if (Number(res.headers.get("content-length") || 0) > MAX_PDF) throw badRequest("That PDF is over 20 MB.");
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_PDF) { await reader.cancel(); throw badRequest("That PDF is over 20 MB."); }
        parts.push(value);
      }
      return Buffer.concat(parts);
    }
    throw badRequest("Too many redirects fetching the PDF.");
  } catch (e) {
    if (e instanceof Response) throw e;
    if (e instanceof Error && e.name === "AbortError") throw badRequest("The PDF took too long to download (10s). Select some text instead.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const isPdf = (b: Buffer) => b.subarray(0, 5).toString("latin1") === "%PDF-";

function cleanTitle(title: string, url: string, fallback: string) {
  const t = title.replace(/\s+/g, " ").trim();
  if (t) return t.slice(0, 120);
  try { return decodeURIComponent(new URL(url).pathname.split("/").pop() || "") || fallback; } catch { return fallback; }
}

export const POST = extHandler(async (req) => {
  const user = await requireExtUser(req);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Send {text, url, title} or {pdfUrl}.");
  const body = parsed.data;
  const text = body.text?.trim() ?? "";
  if (!text && !body.pdfUrl && !body.pdfBase64) return badRequest("Select some text first, then press Teach this back.");
  await enforceAiLimit(user, "ext_capture");

  let subjectId = body.subjectId;
  if (subjectId) {
    if (!await canAccessSubject(user.id, subjectId)) return Response.json({ error: "You don't have access to that subject." }, { status: 403 });
  } else {
    const existing = await get<Subject>("SELECT * FROM subjects WHERE owner_id=? AND name=? ORDER BY created_at LIMIT 1", user.id, WEB_SUBJECT);
    subjectId = (existing ?? await createSubject(user.id, WEB_SUBJECT)).id;
  }

  const sourceUrl = body.url || body.pdfUrl || undefined;
  let result: Awaited<ReturnType<typeof ingestSource>>;
  if (text) {
    const title = cleanTitle(body.title, body.url, "Web selection");
    result = await ingestSource({ subjectId, fileName: title, mime: "text/plain", text, url: sourceUrl });
  } else {
    const data = body.pdfBase64 ? Buffer.from(body.pdfBase64, "base64") : await fetchPdf(body.pdfUrl!);
    if (data.byteLength > MAX_PDF) return badRequest("That PDF is over 20 MB.");
    if (!isPdf(data)) return badRequest("That link isn't a PDF Samjha can read. Select some text instead.");
    const title = cleanTitle(body.title, body.pdfUrl || body.url, "PDF");
    result = await ingestSource({ subjectId, fileName: title.toLowerCase().endsWith(".pdf") ? title : `${title}.pdf`, mime: "application/pdf", data, url: sourceUrl });
  }

  // First topic that holds a claim from this source (new or merged), else the newest topic in the subject.
  const topic =
    await get<Topic>(
      `SELECT t.* FROM topics t JOIN claims c ON c.topic_id=t.id WHERE c.source_id=? GROUP BY t.id ORDER BY MIN(t.position), MIN(c.position) LIMIT 1`,
      result.sourceId,
    ) ?? await get<Topic>("SELECT * FROM topics WHERE subject_id=? ORDER BY rowid DESC LIMIT 1", subjectId);
  if (!topic) return Response.json({ error: "Samjha couldn't find anything to learn in that selection. Try selecting more text." }, { status: 422 });

  const claims = await all<{ id: string; text: string; page: number | null; source_id: string | null }>(
    "SELECT id, text, page, source_id FROM claims WHERE topic_id=? ORDER BY position",
    topic.id,
  );
  const origin = new URL(req.url).origin;
  await logEvent(user.id, "ext_capture", { subjectId, topicId: topic.id, kind: text ? "text" : "pdf", host: safeHost(sourceUrl) });
  return Response.json({
    topicId: topic.id,
    topicName: topic.name,
    subjectId,
    sourceId: result.sourceId,
    claims,
    topicsCreated: result.topicsCreated,
    topicsMerged: result.topicsMerged,
    panelUrl: `${origin}/ext/panel?topicId=${encodeURIComponent(topic.id)}`,
  });
});

function safeHost(u?: string) {
  try { return u ? new URL(u).hostname : null; } catch { return null; }
}
