// Settings shape, defaults and validation. No server-only: shared by API, page and tests.
import { z } from "zod";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

export const NudgeSettingsSchema = z.object({
  email: z.boolean(),
  whatsapp: z.boolean(),
  phone: z.string().trim().max(20).regex(/^\+?[0-9 ()-]*$/, "Phone digits only, with country code").optional(),
  frequency: z.enum(["daily", "every2days", "weekly", "off"]),
  quietStart: hhmm,
  quietEnd: hhmm,
  timezone: z.string().max(64),
});

export const SettingsSchema = z.object({
  autoSubmitMs: z.number().int().min(800).max(4000),
  submitMode: z.enum(["pause", "say_send"]),
  voiceRate: z.number().min(0.5).max(2),
  premiumVoice: z.boolean(),
  voiceName: z.string().max(200).optional(),
  theme: z.enum(["system", "light", "dark"]),
  nudges: NudgeSettingsSchema,
});

export type Settings = z.infer<typeof SettingsSchema>;
export type NudgeSettings = z.infer<typeof NudgeSettingsSchema>;
export type NudgeFrequency = NudgeSettings["frequency"];

export const SETTINGS_DEFAULTS: Settings = {
  autoSubmitMs: 1500,
  submitMode: "pause",
  voiceRate: 1,
  premiumVoice: false,
  theme: "system",
  nudges: {
    email: true,
    whatsapp: false,
    frequency: "daily",
    quietStart: "22:00",
    quietEnd: "08:00",
    timezone: "",
  },
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Recursively merge `patch` onto `base` (objects merge, others replace; undefined ignored, null deletes). */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) return (patch === undefined ? base : patch) as T;
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) {
      delete out[k];
      continue;
    }
    out[k] = isObj(out[k]) && isObj(v) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/** Defaults + stored JSON, tolerating stale/invalid stored values field by field. */
export function normalizeSettings(stored: unknown): Settings {
  const merged = deepMerge(SETTINGS_DEFAULTS, stored);
  const parsed = SettingsSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  // Drop invalid leaves one by one back to defaults.
  const fixed: Obj = structuredClone(merged) as unknown as Obj;
  for (const issue of parsed.error.issues) {
    let target: Obj = fixed;
    let def: unknown = SETTINGS_DEFAULTS;
    const path = issue.path.map(String);
    for (let i = 0; i < path.length - 1; i++) {
      target = (isObj(target[path[i]]) ? target[path[i]] : (target[path[i]] = {})) as Obj;
      def = isObj(def) ? def[path[i]] : undefined;
    }
    const last = path[path.length - 1];
    if (last === undefined) return SETTINGS_DEFAULTS;
    const d = isObj(def) ? def[last] : undefined;
    if (d === undefined) delete target[last];
    else target[last] = d;
  }
  const again = SettingsSchema.safeParse(fixed);
  return again.success ? again.data : SETTINGS_DEFAULTS;
}
