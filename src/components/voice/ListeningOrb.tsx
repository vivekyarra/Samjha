"use client";
// The listening orb: the only voice control. It breathes while idle, swells with the live microphone level, pulses while
// Samjha speaks and ripples when dictated text lands. Wispr Flow types into the transparent field layered over it.
import { useEffect, useRef, type ReactNode } from "react";

const RING = "always listening · wispr flow · speak when you're ready · ";
const R = 49; // ring radius inside the 128 viewBox
const CIRC = 2 * Math.PI * R;

export function ListeningOrb({
  speaking,
  thinking,
  burst,
  label,
  children,
}: {
  speaking: boolean;
  thinking: boolean;
  /** Increment to ripple the orb (new dictation arrived). */
  burst: number;
  /** Short state word shown in the centre. */
  label: string;
  /** The transparent dictation field, layered over the orb. */
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const state = useRef({ speaking, thinking, burst: 0, level: 0 });

  useEffect(() => {
    state.current.speaking = speaking;
    state.current.thinking = thinking;
  }, [speaking, thinking]);

  useEffect(() => {
    if (burst > 0) state.current.burst = 1;
  }, [burst]);

  useEffect(() => {
    let stopped = false;
    let raf = 0;
    let ctx: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let analyser: AnalyserNode | null = null;
    const buf = new Uint8Array(1024);
    const el = ref.current;

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) return;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        ctx = new AudioContext();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(analyser);
        el?.setAttribute("data-mic", "live");
      } catch {
        el?.setAttribute("data-mic", "off");
      }
    })();
    const resume = () => void ctx?.resume();
    window.addEventListener("pointerdown", resume);
    window.addEventListener("keydown", resume);

    const tick = (ms: number) => {
      const t = ms / 1000;
      const s = state.current;
      let mic = 0;
      if (analyser) {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        mic = Math.min(1, Math.sqrt(sum / buf.length) * 5);
      }
      const voice = s.speaking ? 0.32 + 0.3 * (0.5 + 0.5 * Math.sin(t * 9.1)) * (0.5 + 0.5 * Math.sin(t * 2.7 + 1)) : 0;
      const busy = s.thinking ? 0.16 + 0.1 * Math.sin(t * 5) : 0;
      const idle = 0.07 + 0.06 * Math.sin(t * 1.7);
      s.burst *= 0.955;
      const target = Math.max(mic, voice, busy, idle, s.burst * 0.9);
      s.level += (target - s.level) * (target > s.level ? 0.35 : 0.08);
      el?.style.setProperty("--lvl", s.level.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
    };
  }, []);

  return (
    <div ref={ref} className="orb" data-mic="pending" data-speaking={speaking || undefined}>
      <span className="orb-glow" aria-hidden />
      <span className="orb-core" aria-hidden />
      <svg className="orb-ring" viewBox="0 0 128 128" aria-hidden>
        <defs>
          <path id="orb-ring-path" d={`M64,${64 - R} a${R},${R} 0 1,1 -0.01,0`} />
        </defs>
        <text className="orb-ring-text">
          <textPath href="#orb-ring-path" textLength={CIRC - 2} lengthAdjust="spacing">
            {RING}
          </textPath>
        </text>
      </svg>
      <span className="orb-label" aria-hidden>
        {label}
      </span>
      {children}
    </div>
  );
}
