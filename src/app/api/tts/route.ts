// Optional premium voice (spec §5.3). ElevenLabs when ELEVENLABS_API_KEY is set, otherwise 501 so the client uses Web Speech.
import { handler, requireUser } from "@/lib/auth";
import { enforceAiLimit } from "@/lib/ratelimit";

const DEFAULT_VOICE = "EXAVITQu4vr4xnSDxMaL"; // Sarah (premade, usable on the free plan)

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return Response.json({ error: "Premium voice is off" }, { status: 501 });
  const body = (await req.json().catch(() => ({}))) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 1200) : "";
  if (!text) return Response.json({ error: "text is required" }, { status: 400 });
  await enforceAiLimit(user, "tts");
  const voice = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE;
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5" }),
  });
  if (!r.ok || !r.body) {
    console.error("[samjha tts]", r.status, await r.text().catch(() => ""));
    return Response.json({ error: "Premium voice failed" }, { status: 502 });
  }
  return new Response(r.body, { headers: { "content-type": "audio/mpeg", "cache-control": "private, max-age=3600" } });
});
