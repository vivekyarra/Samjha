// Samjha AI client. JSON validation + one retry (spec §8.1).
// Providers, first configured wins:
//   ANTHROPIC_API_KEY              -> Claude
//   GEMINI_API_KEY                 -> Google Gemini (free tier, OpenAI-compatible endpoint, supports images)
//   GROQ_API_KEY                   -> Groq (free tier, very fast)
//   LLM_BASE_URL + LLM_API_KEY     -> any OpenAI-compatible endpoint (OpenRouter, local Ollama, ...)
// When none is set, hasAI() is false and every caller MUST use its local heuristic fallback,
// so the whole product works offline / in demo without a key.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import type { ZodType } from "zod";
import { get, run, now } from "./db";

type Provider = { kind: "anthropic" } | { kind: "openai"; baseUrl: string; apiKey: string; name: string };

function provider(): Provider | null {
  if (process.env.SAMJHA_OFFLINE === "1") return null;
  if (process.env.ANTHROPIC_API_KEY) return { kind: "anthropic" };
  if (process.env.GEMINI_API_KEY)
    return { kind: "openai", name: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: process.env.GEMINI_API_KEY };
  if (process.env.GROQ_API_KEY) return { kind: "openai", name: "groq", baseUrl: "https://api.groq.com/openai/v1", apiKey: process.env.GROQ_API_KEY };
  if (process.env.LLM_BASE_URL && process.env.LLM_API_KEY)
    return { kind: "openai", name: "custom", baseUrl: process.env.LLM_BASE_URL.replace(/\/$/, ""), apiKey: process.env.LLM_API_KEY };
  return null;
}

const DEFAULT_MODELS: Record<string, { strong: string; fast: string }> = {
  anthropic: { strong: "claude-sonnet-5-5", fast: "claude-haiku-5-5" },
  gemini: { strong: "gemini-2.5-flash", fast: "gemini-2.5-flash-lite" },
  groq: { strong: "llama-3.3-70b-versatile", fast: "llama-3.1-8b-instant" },
  custom: { strong: "gpt-4o-mini", fast: "gpt-4o-mini" },
};

function models() {
  const p = provider();
  const d = DEFAULT_MODELS[p ? (p.kind === "anthropic" ? "anthropic" : p.name) : "anthropic"];
  return { strong: process.env.SAMJHA_MODEL_STRONG || d.strong, fast: process.env.SAMJHA_MODEL_FAST || d.fast };
}
/** Resolved model names for the active provider. */
export const MODELS = {
  get strong() { return models().strong; },
  get fast() { return models().fast; },
};

export function hasAI(): boolean {
  return provider() !== null;
}
/** Name of the active provider, for display ("claude", "gemini", "groq", "custom", "offline"). */
export function aiProviderName(): string {
  const p = provider();
  return !p ? "offline" : p.kind === "anthropic" ? "claude" : p.name;
}

let client: Anthropic | null = null;
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
  /** If set, identical calls are served from the ai_cache table. */
  cache?: boolean;
  /** Ask the provider for JSON output where supported. */
  json?: boolean;
}

function anthropicContent(o: AiOpts): Anthropic.MessageParam["content"] {
  const parts: Anthropic.ContentBlockParam[] = [];
  for (const img of o.images ?? []) parts.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } });
  parts.push({ type: "text", text: o.user });
  return parts;
}

function openaiBody(o: AiOpts, stream: boolean) {
  const userContent = o.images?.length
    ? [...o.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mediaType};base64,${i.base64}` } })), { type: "text", text: o.user }]
    : o.user;
  return {
    model: models()[o.model ?? "strong"],
    max_tokens: o.maxTokens ?? 1500,
    stream,
    ...(o.json ? { response_format: { type: "json_object" } } : {}),
    messages: [
      { role: "system", content: o.system },
      { role: "user", content: userContent },
    ],
  };
}

async function openaiFetch(p: Extract<Provider, { kind: "openai" }>, o: AiOpts, stream: boolean): Promise<Response> {
  const res = await fetch(`${p.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
    body: JSON.stringify(openaiBody(o, stream)),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`${p.name} API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

/** Plain text completion. */
export async function aiText(o: AiOpts): Promise<string> {
  const p = provider();
  if (!p) throw new Error("No AI provider configured");
  const key = o.cache ? cacheKey(o) : null;
  if (key) {
    const hit = await get<{ value: string }>("SELECT value FROM ai_cache WHERE key=?", key);
    if (hit) return hit.value;
  }
  let text: string;
  if (p.kind === "anthropic") {
    const res = await anthropic().messages.create({
      model: models()[o.model ?? "strong"],
      max_tokens: o.maxTokens ?? 1500,
      system: o.system,
      messages: [{ role: "user", content: anthropicContent(o) }],
    });
    text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  } else {
    const data = (await (await openaiFetch(p, o, false)).json()) as { choices?: { message?: { content?: string } }[] };
    text = data.choices?.[0]?.message?.content ?? "";
  }
  if (key) await run("INSERT INTO ai_cache (key,value,created_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, created_at=excluded.created_at", key, text, now());
  return text;
}

/** Streams text deltas. */
export async function* aiStream(o: AiOpts): AsyncGenerator<string> {
  const p = provider();
  if (!p) throw new Error("No AI provider configured");
  if (p.kind === "anthropic") {
    const stream = anthropic().messages.stream({
      model: models()[o.model ?? "strong"],
      max_tokens: o.maxTokens ?? 1200,
      system: o.system,
      messages: [{ role: "user", content: anthropicContent(o) }],
    });
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield ev.delta.text;
    }
    return;
  }
  const res = await openaiFetch(p, o, true);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const delta = (JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        /* partial keep-alive line */
      }
    }
  }
}

/** JSON completion validated against a zod schema; retried once on parse/validation failure. */
export async function aiJSON<T>(o: AiOpts, schema: ZodType<T>): Promise<T> {
  const sys = `${o.system}\n\nRespond with ONLY a single JSON object. No prose, no markdown fences.`;
  let lastErr: unknown;
  for (let i = 0; i < 2; i++) {
    const raw = await aiText({
      ...o,
      json: true,
      system: sys,
      user: i === 0 ? o.user : `${o.user}\n\nYour previous reply was not valid JSON for the schema (${String(lastErr).slice(0, 300)}). Reply again with valid JSON only.`,
      cache: o.cache && i === 0,
    });
    try {
      return schema.parse(extractJson(raw));
    } catch (e) {
      lastErr = e;
      if (o.cache) await run("DELETE FROM ai_cache WHERE key=?", cacheKey({ ...o, json: true, system: sys }));
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
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([aiProviderName(), models()[o.model ?? "strong"], o.system, o.user, o.images?.map((i) => i.base64.length)]))
    .digest("hex");
}
