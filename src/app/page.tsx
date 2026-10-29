// Landing page. Signed-in users go straight to their heatmap (or onboarding).
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const STEPS = [
  {
    n: "1",
    title: "You explain it",
    body: "Pick a topic from your own notes and explain it out loud, like you're teaching a junior. Hold your Wispr Flow key and just talk.",
  },
  {
    n: "2",
    title: "Samjha diagnoses",
    body: "Every key idea in your notes is checked: covered, missing or wrong, with your own words quoted as evidence and the page it came from.",
  },
  {
    n: "3",
    title: "Your buddy fixes only the gaps",
    body: "Short, casual, in your style (cricket analogies, Hinglish, “like I'm 12”). Interrupt any time: “wait, why?”, “example”, “shorter”.",
  },
  {
    n: "4",
    title: "Explain it back, watch it turn green",
    body: "Say it again. The ideas you now get flip to green, and spaced repetition keeps them that way.",
  },
];

const SAMPLE = [
  { icon: "✓", label: "Covered", text: "Gradient descent repeatedly adjusts the weights to reduce the loss", cls: "border-green/40 bg-green-soft text-green" },
  { icon: "✕", label: "Wrong", text: "“we move in the direction of the gradient” → opposite direction (p.2)", cls: "border-red/40 bg-red-soft text-red" },
  { icon: "○", label: "Missing", text: "Converges where the gradient is close to zero, maybe a local minimum", cls: "border-amber/40 bg-amber-soft text-amber" },
];

export default async function Landing({ searchParams }: { searchParams: Promise<{ demo?: string }> }) {
  const user = await currentUser();
  if (user) redirect(user.onboarded ? "/home" : "/onboarding");
  const { demo } = await searchParams;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-4">
        <span className="text-lg font-bold tracking-tight">
          Samjha<span className="text-accent">.</span>
        </span>
        <Link href="/login" className="btn-ghost">Sign in</Link>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4">
        {demo === "busy" && (
          <p role="status" className="mt-2 rounded-xl border border-amber/40 bg-amber-soft px-4 py-3 text-sm">
            Lots of people from your network are trying Samjha right now. Give it a little while, or sign in with your email.
          </p>
        )}
        {demo === "error" && (
          <p role="alert" className="mt-2 rounded-xl border border-red/40 bg-red-soft px-4 py-3 text-sm">
            We couldn&apos;t open the sample workspace. Please try again.
          </p>
        )}

        <section className="grid items-center gap-10 py-12 sm:py-20 md:grid-cols-[1.2fr_1fr]">
          <div>
            <p className="mb-4 text-sm font-medium text-accent">A study buddy you only talk to</p>
            <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
              You don&apos;t know it until you can say it.
            </h1>
            <p className="mt-5 max-w-xl text-lg text-muted">
              Explain a topic out loud. Samjha finds exactly what you don&apos;t get, checked against your own notes,
              and explains only that, the way a friend would.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href="/demo" prefetch={false} className="btn-primary px-6 py-3 text-base">
                Try Samjha now, no signup
              </Link>
              <Link href="/login" className="btn-ghost px-6 py-3 text-base">Sign in with email</Link>
            </div>
            <p className="mt-4 muted">Takes under a minute. Works with typing too.</p>
          </div>

          <div className="card space-y-3 shadow-sm" aria-label="Example diagnosis">
            <p className="muted">You explained <span className="font-medium text-fg">Gradient Descent</span></p>
            {SAMPLE.map((s) => (
              <div key={s.label} className={`flex gap-3 rounded-xl border px-3 py-2.5 ${s.cls}`}>
                <span aria-hidden className="mt-0.5 font-bold">{s.icon}</span>
                <div className="text-sm">
                  <span className="font-semibold">{s.label}</span>
                  <span className="text-fg">: {s.text}</span>
                </div>
              </div>
            ))}
            <p className="pt-1 text-sm text-muted">
              Buddy: &ldquo;You nailed the loop. One flip though: the gradient points <em>uphill</em>, so we step the
              other way. Now explain it back to me.&rdquo;
            </p>
          </div>
        </section>

        <section className="py-10">
          <h2 className="h1 max-w-2xl">Five hours alone, or five minutes with a friend</h2>
          <p className="mt-3 max-w-2xl text-muted">
            The friend doesn&apos;t know more than the textbook. They just know what <em>you</em> don&apos;t get, talk
            like you, and give only the essentials. Samjha does the same, any time.
          </p>
          <ol className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s) => (
              <li key={s.n} className="card">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-fg">
                  {s.n}
                </span>
                <h3 className="mt-3 font-semibold">{s.title}</h3>
                <p className="mt-1 text-sm text-muted">{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="grid gap-4 py-10 md:grid-cols-3">
          <div className="card">
            <h3 className="font-semibold">Voice first, built for Wispr Flow</h3>
            <p className="mt-1 text-sm text-muted">
              One big Voice Box on every screen. Dictate with Wispr Flow and it submits when you pause. Every action,
              from &ldquo;open backprop&rdquo; to &ldquo;exam tomorrow&rdquo;, works by voice. The keyboard is optional.
            </p>
          </div>
          <div className="card">
            <h3 className="font-semibold">Grounded in your notes</h3>
            <p className="mt-1 text-sm text-muted">
              Upload PDFs, slides, photos of handwritten notes or a syllabus. Every grade and every explanation cites
              the page it came from.
            </p>
          </div>
          <div className="card">
            <h3 className="font-semibold">Beyond one session</h3>
            <p className="mt-1 text-sm text-muted">
              Heatmap and spaced repetition, exam-eve crash mode, root-cause tracing, an anonymous class heatmap,
              and viva and placement practice.
            </p>
          </div>
        </section>

        <section className="my-10 rounded-3xl bg-surface-2 px-6 py-10 text-center">
          <h2 className="h1">See it find your gaps</h2>
          <p className="mx-auto mt-2 max-w-md text-muted">
            The sample workspace opens an &ldquo;Intro to Machine Learning&rdquo; course with a half-red heatmap. Explain
            Gradient Descent and watch what happens.
          </p>
          <Link href="/demo" prefetch={false} className="btn-primary mt-6 px-6 py-3 text-base">
            Try Samjha now, no signup
          </Link>
        </section>
      </main>

      <footer className="mx-auto w-full max-w-5xl px-4 py-6 text-sm text-muted">
        Samjha, built entirely by voice for the No Hands Wispr Challenge.
      </footer>
    </div>
  );
}
