import "server-only";
import { get, run } from "@/lib/db";
import { deepMerge, normalizeSettings, SettingsSchema, type Settings } from "./schema";

export { SETTINGS_DEFAULTS, SettingsSchema, type Settings, type NudgeSettings } from "./schema";

async function readRaw(userId: string): Promise<unknown> {
  const row = await get<{ json: string }>("SELECT json FROM settings WHERE user_id=?", userId);
  if (!row) return {};
  try {
    return JSON.parse(row.json);
  } catch {
    return {};
  }
}

/** Full settings for a user: defaults deep-merged with what they saved. */
export async function getSettings(userId: string): Promise<Settings> {
  return normalizeSettings(await readRaw(userId));
}

/** Merge a (partial) patch into the user's settings, validate, persist. Throws a ZodError on invalid input. */
export async function saveSettings(userId: string, patch: unknown): Promise<Settings> {
  const next = SettingsSchema.parse(deepMerge(await getSettings(userId), patch));
  // Keep any extra keys other modules may have stored in settings.json.
  const raw = await readRaw(userId);
  const extras: Record<string, unknown> = typeof raw === "object" && raw && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  for (const k of Object.keys(SettingsSchema.shape)) delete extras[k];
  const stored = { ...extras, ...next };
  await run(
    "INSERT INTO settings (user_id, json) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET json=excluded.json",
    userId,
    JSON.stringify(stored),
  );
  return next;
}
