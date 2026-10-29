import "server-only";
import crypto from "node:crypto";
import { all, get, run, newId, now as isoNow, logEvent } from "@/lib/db";
import { getSettings, saveSettings } from "@/lib/settings";
import { dueToday } from "@/lib/mastery";
import type { User } from "@/lib/types";
import { decideNudge, dueBody, type ExamInfo, type NudgeDecision } from "./rules";

export type Channel = "email" | "whatsapp" | "in_app";
export type NudgeStatus = "sent" | "in_app" | "failed" | "pending";

export interface NudgeRow {
  id: string; user_id: string; channel: Channel; kind: string | null; body: string | null;
  link: string | null; status: NudgeStatus | null; sent_at: string | null; opened_at: string | null;
}

export interface ComputedNudge extends NudgeDecision {
  /** In-app destination (before open tracking). */
  link: string;
  dueCount: number;
  channels: Channel[];
}

const SECRET = process.env.SAMJHA_SECRET || "samjha-dev-secret-change-me";

export function appUrl(origin?: string): string {
  const env =
    process.env.SAMJHA_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "");
  return (env || origin || "http://localhost:3000").replace(/\/+$/, "");
}

// ---------- due counts ----------

/** Number of claims due today (mastery's dueToday), with a direct SQL fallback. */
export async function dueClaimCount(userId: string, at: Date = new Date()): Promise<number> {
  try {
    return (await dueToday(userId)).total;
  } catch (e) {
    console.warn("[nudges] dueToday failed, using SQL fallback", e);
  }
  const endOfDay = new Date(at.getTime() + 24 * 3600_000);
  endOfDay.setUTCHours(0, 0, 0, 0);
  return (
    (await get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM claim_cards WHERE user_id=? AND due_at IS NOT NULL AND due_at < ?",
      userId,
      endOfDay.toISOString(),
    ))?.n ?? 0
  );
}

// ---------- decision ----------

function channelsFor(user: User, s: Awaited<ReturnType<typeof getSettings>>): Channel[] {
  const out: Channel[] = [];
  if (s.nudges.email && user.email) out.push("email");
  if (s.nudges.whatsapp && s.nudges.phone && s.nudges.phone.replace(/\D/g, "").length >= 8) out.push("whatsapp");
  return out;
}

async function examsFor(userId: string): Promise<ExamInfo[]> {
  return (await all<{ id: string; name: string; exam_date: string }>(
    `SELECT s.id, s.name, s.exam_date FROM subjects s JOIN subject_members m ON m.subject_id=s.id
     WHERE m.user_id=? AND s.exam_date IS NOT NULL AND s.exam_date != ''`,
    userId,
  )).map((r) => ({ subjectId: r.id, name: r.name, examDate: r.exam_date }));
}

/** Decide whether this user should get a nudge right now, and what it says. */
export async function computeNudge(userId: string, nowDate: Date = new Date()): Promise<ComputedNudge> {
  const user = await get<User>("SELECT * FROM users WHERE id=?", userId);
  if (!user) throw new Error("User not found");
  const settings = await getSettings(userId);
  const channels = channelsFor(user, settings);
  const dueCount = await dueClaimCount(userId, nowDate);
  const last = await get<{ t: string | null }>(
    `SELECT MAX(sent_at) AS t FROM nudges WHERE user_id=? AND status IN ('sent','in_app') AND IFNULL(kind,'') NOT IN ('test','exam_eve')`,
    userId,
  );
  const dayAgo = new Date(nowDate.getTime() - 24 * 3600_000).toISOString();
  const examEveSentFor = (await all<{ link: string | null }>(
    `SELECT link FROM nudges WHERE user_id=? AND kind='exam_eve' AND status IN ('sent','in_app') AND sent_at > ?`,
    userId,
    dayAgo,
  ))
    .map((r) => /subjectId=([^&]+)/.exec(decodeURIComponent(r.link ?? ""))?.[1])
    .filter((x): x is string => !!x);

  const decision = decideNudge({
    now: nowDate,
    nudges: settings.nudges,
    dueCount,
    lastSentAt: last?.t ?? null,
    exams: await examsFor(userId),
    examEveSentFor,
    hasChannel: channels.length > 0,
  });
  return { ...decision, link: decision.target, dueCount, channels };
}

// ---------- links + unsubscribe ----------

/** Where the nudge lands, tagged so the session knows it came from a nudge. */
export function sessionTarget(target: string, nudgeId: string): string {
  const sep = target.includes("?") ? "&" : "?";
  return `${target}${sep}from=nudge&n=${encodeURIComponent(nudgeId)}`;
}

/** Open-tracking link: records opened_at, then redirects into the session. */
export function openLink(nudgeId: string, target: string): string {
  return `/api/nudges/open?n=${encodeURIComponent(nudgeId)}&to=${encodeURIComponent(sessionTarget(target, nudgeId))}`;
}

const hmac = (v: string) => crypto.createHmac("sha256", SECRET).update(`unsub:${v}`).digest("base64url").slice(0, 32);

export function unsubscribeToken(userId: string): string {
  return `${userId}.${hmac(userId)}`;
}

/** Validates the token; returns the user id or null. */
export function verifyUnsubscribeToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const userId = token.slice(0, i);
  const a = Buffer.from(token.slice(i + 1));
  const b = Buffer.from(hmac(userId));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? userId : null;
}

/** One-tap unsubscribe: turns nudges off. Returns the user's name or null if the token is bad. */
export async function unsubscribe(token: string | null | undefined): Promise<{ name: string } | null> {
  const userId = verifyUnsubscribeToken(token);
  if (!userId) return null;
  const user = await get<{ name: string }>("SELECT name FROM users WHERE id=?", userId);
  if (!user) return null;
  await saveSettings(userId, { nudges: { frequency: "off" } });
  await logEvent(userId, "nudges_unsubscribed", {});
  return user;
}

export async function markOpened(nudgeId: string): Promise<boolean> {
  const r = await run("UPDATE nudges SET opened_at=? WHERE id=? AND opened_at IS NULL", isoNow(), nudgeId);
  if (Number(r.changes) > 0) {
    const row = await get<{ user_id: string; kind: string | null }>("SELECT user_id, kind FROM nudges WHERE id=?", nudgeId);
    if (row) await logEvent(row.user_id, "nudge_opened", { nudgeId, kind: row.kind });
    return true;
  }
  return false;
}

export async function listNudges(userId: string, limit = 50): Promise<NudgeRow[]> {
  return all<NudgeRow>("SELECT * FROM nudges WHERE user_id=? ORDER BY sent_at DESC LIMIT ?", userId, limit);
}

// ---------- delivery ----------

interface Delivery { status: NudgeStatus; error?: string }

async function sendEmail(to: string, body: string, url: string, unsubUrl: string): Promise<Delivery> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { status: "in_app" };
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const html = `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#1c1b19">
<p>${esc(body)}</p>
<p><a href="${esc(url)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none">Start review</a></p>
<p style="font-size:12px;color:#6b6860">Samjha nudges. <a href="${esc(unsubUrl)}" style="color:#6b6860">Unsubscribe in one tap</a>.</p></div>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || "Samjha <nudges@samjha.app>",
        to: [to],
        subject: `Samjha: ${body}`,
        html,
        text: `${body}\n\nStart review: ${url}\n\nUnsubscribe: ${unsubUrl}`,
        headers: { "List-Unsubscribe": `<${unsubUrl}>` },
      }),
    });
    if (!res.ok) return { status: "failed", error: `Resend ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { status: "sent" };
  } catch (e) {
    return { status: "failed", error: String(e) };
  }
}

async function sendWhatsApp(phone: string, body: string, url: string, unsubUrl: string): Promise<Delivery> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !from) return { status: "in_app" };
  const digits = phone.replace(/[^\d+]/g, "");
  const to = `whatsapp:${digits.startsWith("+") ? digits : `+${digits}`}`;
  const form = new URLSearchParams({
    From: from.startsWith("whatsapp:") ? from : `whatsapp:${from}`,
    To: to,
    Body: `${body}\n${url}\n\nStop these: ${unsubUrl}`,
  });
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    if (!res.ok) return { status: "failed", error: `Twilio ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { status: "sent" };
  } catch (e) {
    return { status: "failed", error: String(e) };
  }
}

export interface SendResult {
  decision: ComputedNudge;
  nudges: (NudgeRow & { error?: string })[];
}

/**
 * Compute and deliver a nudge for one user. `test: true` ignores cadence/quiet hours and always sends
 * (to enabled channels, or an in-app row if none). Without provider keys rows are stored as "in_app".
 */
export async function sendNudge(userId: string, opts: { now?: Date; test?: boolean; origin?: string } = {}): Promise<SendResult> {
  const at = opts.now ?? new Date();
  let decision = await computeNudge(userId, at);
  if (opts.test) {
    const body =
      decision.shouldSend && decision.body
        ? decision.body
        : decision.dueCount > 0
          ? dueBody(decision.dueCount)
          : "Nothing due right now. Explain one topic to keep your streak going.";
    decision = { ...decision, shouldSend: true, reason: "Test nudge", kind: decision.kind ?? "due", body, link: decision.shouldSend ? decision.link : "/review", target: decision.shouldSend ? decision.target : "/review" };
  }
  if (!decision.shouldSend) return { decision, nudges: [] };

  const user = (await get<User>("SELECT * FROM users WHERE id=?", userId))!;
  const settings = await getSettings(userId);
  const channels: Channel[] = decision.channels.length ? decision.channels : opts.test ? ["in_app"] : [];
  const base = appUrl(opts.origin);
  const unsubUrl = `${base}/unsubscribe?token=${encodeURIComponent(unsubscribeToken(userId))}`;
  const kind = opts.test ? "test" : decision.kind;
  const out: SendResult["nudges"] = [];

  for (const channel of channels) {
    const id = newId("n_");
    const link = openLink(id, decision.link);
    const sentAt = isoNow();
    await run(
      "INSERT INTO nudges (id,user_id,channel,kind,body,link,status,sent_at) VALUES (?,?,?,?,?,?,?,?)",
      id, userId, channel, kind, decision.body, link, "pending", sentAt,
    );
    const url = base + link;
    const d: Delivery =
      channel === "email"
        ? await sendEmail(user.email!, decision.body, url, unsubUrl)
        : channel === "whatsapp"
          ? await sendWhatsApp(settings.nudges.phone ?? "", decision.body, url, unsubUrl)
          : { status: "in_app" };
    await run("UPDATE nudges SET status=? WHERE id=?", d.status, id);
    if (d.error) console.warn(`[nudges] ${channel} failed for ${userId}: ${d.error}`);
    await logEvent(userId, "nudge_sent", { nudgeId: id, channel, kind, status: d.status });
    out.push({ id, user_id: userId, channel, kind, body: decision.body, link, status: d.status, sent_at: sentAt, opened_at: null, error: d.error });
  }
  return { decision, nudges: out };
}

/** Hourly cron: evaluate every real (non-demo) user. */
export async function runNudgeCron(at: Date = new Date(), origin?: string) {
  const users = await all<{ id: string }>("SELECT id FROM users WHERE is_demo=0");
  const summary = { checked: users.length, sent: 0, inApp: 0, failed: 0, skipped: 0, errors: 0 };
  for (const u of users) {
    try {
      const r = await sendNudge(u.id, { now: at, origin });
      if (!r.nudges.length) summary.skipped++;
      for (const n of r.nudges) {
        if (n.status === "sent") summary.sent++;
        else if (n.status === "in_app") summary.inApp++;
        else summary.failed++;
      }
    } catch (e) {
      summary.errors++;
      console.error("[nudges] cron error for", u.id, e);
    }
  }
  return summary;
}
