// Samjha AI client. Wraps the Claude API with JSON validation + one retry (spec §8.1).
// When ANTHROPIC_API_KEY is not set, hasAI() is false and every caller MUST use its local heuristic fallback,
// so the whole product works offline / in demo without a key.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import type { ZodType } from "zod";
import { get, run, now } from "./db";

export const MODELS = {
  strong: process.env.SAMJHA_MODEL_STRONG || "claude-sonnet-5-5",
  fast: process.env.SAMJHA_MODEL_FAST || "claude-haiku-5-5",
};

let client: Anthropic | null = null;
export function hasAI(): boolean {
  return !!process.env.ANTHROPIC_API_KEY && process.env.SAMJHA_OFFLINE !== "1";
}
function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

export interface ImageInput { mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; base64: string }
export interface AiOpts {
  system: string;
  user: string;
  model?: "strong" | "fast";
  maxTokens?: number;
  images?: ImageInput[];
  /** Cache key material; if set, identical calls are served from the ai_cache table. */
  cache?: boolean;
}

function content(o: AiOpts): Anthropic.MessageParam["content"] {
  const parts: Anthropic.ContentBlockParam[] = [];
  for (const img of o.images ?? []) parts.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } });
  parts.push({ type: "text", text: o.user });
  return parts;
}

/** Plain text completion. */
export async function aiText(o: AiOpts): Promise<string> {
  const key = o.cache ? cacheKey(o) : null;
  if (key) {
    const hit = get<{ value: string }>("SELECT value FROM ai_cache WHERE key=?", key);
    if (hit) return hit.value;
  }
  const res = await anthropic().messages.create({
    model: MODELS[o.model ?? "strong"],
    max_tokens: o.maxTokens ?? 1500,
    system: o.system,
    messages: [{ role: "user", content: content(o) }],
  });
  const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  if (key) run("INSERT OR REPLACE INTO ai_cache (key,value,created_at) VALUES (?,?,?)", key, text, now());
  return text;
}

/** Streams text deltas. */
export async function* aiStream(o: AiOpts): AsyncGenerator<string> {
  const stream = anthropic().messages.stream({
    model: MODELS[o.model ?? "strong"],
    max_tokens: o.maxTokens ?? 1200,
    system: o.system,
    messages: [{ role: "user", content: content(o) }],
  });
  for await (const ev of stream) {
    if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield ev.delta.text;
  }
}

/** JSON completion validated against a zod schema; retried once on parse/validation failure. */
export async function aiJSON<T>(o: AiOpts, schema: ZodType<T>): Promise<T> {
  const sys = `${o.system}\n\nRespond with ONLY a single JSON object. No prose, no markdown fences.`;
  let lastErr: unknown;
  for (let i = 0; i < 2; i++) {
    const raw = await aiText({ ...o, system: sys, user: i === 0 ? o.user : `${o.user}\n\nYour previous reply was not valid JSON for the schema (${String(lastErr).slice(0, 300)}). Reply again with valid JSON only.`, cache: o.cache && i === 0 });
    try {
      return schema.parse(extractJson(raw));
    } catch (e) {
      lastErr = e;
      if (o.cache) run("DELETE FROM ai_cache WHERE key=?", cacheKey(o));
    }
  }
  throw new Error(`AI JSON validation failed: ${String(lastErr)}`);
}

export function extractJson(raw: string): unknown {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = s.search(/[[{]/);
  const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  return JSON.parse(start >= 0 && end > start ? s.slice(start, end + 1) : s);
}

function cacheKey(o: AiOpts) {
  return crypto.createHash("sha256").update(JSON.stringify([o.model, o.system, o.user, o.images?.map((i) => i.base64.length)])).digest("hex");
}
