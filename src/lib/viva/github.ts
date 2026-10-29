// Placement mode: read a GitHub repository (public API) or a pasted README into a RepoSummary.
import "server-only";
import type { RepoSummary } from "./types";

const TIMEOUT = 6000;
const MAX_PATHS = 300;

export class RepoError extends Error {}

export function parseGitHubUrl(input: string): { owner: string; repo: string } | null {
  const s = input.trim();
  const m =
    s.match(/github\.com[/:]([A-Za-z0-9-_.]+)\/([A-Za-z0-9-_.]+)/i) ??
    s.match(/^([A-Za-z0-9-_.]+)\/([A-Za-z0-9-_.]+)$/);
  if (!m) return null;
  const repo = m[2].replace(/\.git$/i, "");
  if (!m[1] || !repo) return null;
  return { owner: m[1], repo };
}

function headers(accept = "application/vnd.github+json"): HeadersInit {
  const h: Record<string, string> = { Accept: accept, "User-Agent": "Samjha-Viva", "X-GitHub-Api-Version": "2022-11-28" };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function gh(url: string, accept?: string): Promise<Response> {
  try {
    return await fetch(url, { headers: headers(accept), signal: AbortSignal.timeout(TIMEOUT), cache: "no-store" });
  } catch {
    throw new RepoError("GitHub took too long to answer. Paste your README or describe the project instead.");
  }
}

function explain(res: Response): RepoError {
  if (res.status === 404) return new RepoError("I couldn't find that repository. It may be private or misspelt. Paste your README or a project description instead.");
  if (res.status === 403 || res.status === 429) return new RepoError("GitHub is busy right now. Paste the README to continue, and we'll start right away.");
  return new RepoError(`GitHub returned an error (${res.status}). Paste your README or a project description instead.`);
}

interface RepoMeta { name: string; full_name: string; description: string | null; language: string | null; default_branch: string; topics?: string[] }
interface TreeResp { tree?: { path: string; type: string }[]; truncated?: boolean }

export async function fetchRepo(url: string): Promise<{ meta: RepoMeta; readme: string; paths: string[]; languages: string[]; depFiles: Record<string, string> }> {
  const p = parseGitHubUrl(url);
  if (!p) throw new RepoError("That doesn't look like a GitHub repository link. Try github.com/owner/repo, or paste your README.");
  const base = `https://api.github.com/repos/${p.owner}/${p.repo}`;
  const metaRes = await gh(base);
  if (!metaRes.ok) throw explain(metaRes);
  const meta = (await metaRes.json()) as RepoMeta;

  const [readmeRes, treeRes, langRes] = await Promise.all([
    gh(`${base}/readme`, "application/vnd.github.raw").catch(() => null),
    gh(`${base}/git/trees/${encodeURIComponent(meta.default_branch)}?recursive=1`).catch(() => null),
    gh(`${base}/languages`).catch(() => null),
  ]);
  const readme = readmeRes?.ok ? (await readmeRes.text()).slice(0, 40000) : "";
  let paths: string[] = [];
  if (treeRes?.ok) {
    const t = (await treeRes.json()) as TreeResp;
    paths = (t.tree ?? []).filter((x) => x.type === "blob" || x.type === "tree").map((x) => x.path).filter((x) => !/(^|\/)(node_modules|\.git|dist|build|vendor|\.next)(\/|$)/.test(x)).slice(0, MAX_PATHS);
  }
  let languages: string[] = [];
  if (langRes?.ok) {
    const l = (await langRes.json()) as Record<string, number>;
    languages = Object.entries(l).sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 5);
  }
  if (!languages.length && meta.language) languages = [meta.language];

  const depFiles: Record<string, string> = {};
  const wanted = ["package.json", "requirements.txt", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml"].filter((f) => paths.includes(f));
  await Promise.all(
    wanted.slice(0, 3).map(async (f) => {
      const r = await gh(`${base}/contents/${f}?ref=${encodeURIComponent(meta.default_branch)}`, "application/vnd.github.raw").catch(() => null);
      if (r?.ok) depFiles[f] = (await r.text()).slice(0, 20000);
    }),
  );
  return { meta, readme, paths, languages, depFiles };
}

function parseDeps(files: Record<string, string>): string[] {
  const out: string[] = [];
  const pkg = files["package.json"];
  if (pkg) {
    try {
      const j = JSON.parse(pkg) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      out.push(...Object.keys(j.dependencies ?? {}), ...Object.keys(j.devDependencies ?? {}).filter((d) => !d.startsWith("@types/")).slice(0, 5));
    } catch { /* ignore malformed package.json */ }
  }
  const req = files["requirements.txt"];
  if (req) out.push(...req.split(/\r?\n/).map((l) => l.trim().split(/[=<>~![; ]/)[0]).filter((l) => l && !l.startsWith("#") && !l.startsWith("-")));
  const py = files["pyproject.toml"];
  if (py) for (const m of py.matchAll(/^\s*"?([A-Za-z0-9_.-]+)\s*(?:[=<>~]|"\s*,|=\s*["{])/gm)) if (!/^(name|version|description|python|requires|readme|license|authors)$/i.test(m[1])) out.push(m[1]);
  const gomod = files["go.mod"];
  if (gomod) for (const m of gomod.matchAll(/^\s+([\w.-]+\/[\w./-]+)\s+v/gm)) out.push(m[1].split("/").slice(-1)[0]);
  const cargo = files["Cargo.toml"];
  if (cargo) {
    const sec = cargo.split(/\[dependencies\]/)[1]?.split(/\n\[/)[0] ?? "";
    for (const m of sec.matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)) out.push(m[1]);
  }
  return [...new Set(out)].slice(0, 25);
}

/** Dependencies mentioned in prose (e.g. pasted README "Built with React, FastAPI and Postgres"). */
const KNOWN_TECH = ["react", "next.js", "nextjs", "vue", "angular", "svelte", "express", "fastapi", "flask", "django", "spring", "node", "postgres", "postgresql", "mysql", "mongodb", "redis", "sqlite", "supabase", "firebase", "docker", "kubernetes", "aws", "gcp", "azure", "tensorflow", "pytorch", "scikit-learn", "pandas", "numpy", "opencv", "langchain", "openai", "claude", "graphql", "rest", "websocket", "kafka", "rabbitmq", "tailwind", "prisma", "stripe", "jwt", "oauth", "celery", "nginx", "typescript", "flutter", "kotlin", "swift"];

export function headingsOf(readme: string): string[] {
  const hs = [...readme.matchAll(/^#{1,3}\s+(.+?)\s*#*$/gm)].map((m) => m[1].replace(/[`*_[\]]|\(.*?\)|<[^>]+>|:[a-z_]+:/g, "").trim());
  return [...new Set(hs.filter((h) => h.length > 2 && h.length < 60 && !/^(table of contents|contents|license|licence|contributing|contributors|acknowledg|badges?)/i.test(h)))].slice(0, 12);
}

const NOTABLE = /(^|\/)(main|app|index|server|api|routes?|models?|schema|db|database|auth|config|worker|pipeline|train|inference|handler|controller|service|store|utils?)\.[a-z]+$|Dockerfile$|docker-compose\.ya?ml$|\.github\/workflows\/|migrations?\//i;

export function summarize(input: { url: string | null; name?: string; description?: string; readme?: string; paths?: string[]; languages?: string[]; depFiles?: Record<string, string>; topics?: string[] }): RepoSummary {
  const readme = input.readme ?? "";
  const paths = input.paths ?? [];
  const desc = (input.description ?? "").trim();
  const headings = headingsOf(readme);
  const titleFromReadme = readme.match(/^#\s+(.+)$/m)?.[1]?.replace(/[`*_]/g, "").trim();
  const name = input.name || titleFromReadme || (desc ? desc.split(/[.\n]/)[0].slice(0, 40) : "your project");

  const dirCounts = new Map<string, number>();
  for (const p of paths) {
    const parts = p.split("/");
    if (parts.length > 1) dirCounts.set(parts[0], (dirCounts.get(parts[0]) ?? 0) + 1);
  }
  const topDirs = [...dirCounts.entries()].filter(([d]) => !d.startsWith(".")).sort((a, b) => b[1] - a[1]).map(([d]) => d).slice(0, 6);
  const files = paths.filter((p) => /\.[a-z0-9]+$/i.test(p) || /Dockerfile$/.test(p));
  const notableFiles = [...new Set([...files.filter((p) => NOTABLE.test(p)), ...files.filter((p) => /\.(py|ts|tsx|js|go|rs|java|kt|rb|cpp|c|swift)$/.test(p) && p.split("/").length <= 3)])].slice(0, 12);

  let deps = parseDeps(input.depFiles ?? {});
  const prose = `${readme}\n${desc}`.toLowerCase();
  if (deps.length < 3) deps = [...new Set([...deps, ...KNOWN_TECH.filter((t) => new RegExp(`(^|[^a-z])${t.replace(/[.+]/g, "\\$&")}([^a-z]|$)`).test(prose))])].slice(0, 15);

  const hasTests = paths.some((p) => /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[a-z]+$|_test\.(go|py)$/i.test(p)) || /\b(pytest|jest|vitest|unit tests?)\b/i.test(prose);
  const terms = [...new Set([
    ...deps.map((d) => d.toLowerCase()),
    ...notableFiles.map((f) => f.split("/").pop()!.replace(/\.[a-z0-9]+$/i, "").toLowerCase()),
    ...topDirs.map((d) => d.toLowerCase()),
    ...headings.flatMap((h) => h.toLowerCase().split(/\s+/)).filter((w) => w.length > 4),
    ...(input.languages ?? []).map((l) => l.toLowerCase()),
    ...(input.topics ?? []).map((t) => t.toLowerCase()),
  ])].filter((t) => t.length > 2).slice(0, 60);

  const excerpt = readme.replace(/<[^>]+>/g, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\n{3,}/g, "\n\n").slice(0, 6000);
  return {
    label: input.url ? (parseGitHubUrl(input.url) ? `${parseGitHubUrl(input.url)!.owner}/${parseGitHubUrl(input.url)!.repo}` : input.url) : name,
    url: input.url,
    name,
    description: desc || readme.replace(/^#.*$/gm, "").replace(/\s+/g, " ").trim().slice(0, 240),
    languages: input.languages ?? [],
    topDirs,
    notableFiles,
    deps,
    readmeHeadings: headings,
    hasTests,
    terms,
    readmeExcerpt: excerpt || desc.slice(0, 6000),
    pathsSample: paths.slice(0, 120),
  };
}

/** Build a RepoSummary from a URL and/or pasted text. Throws RepoError with a user-facing message. */
export async function loadRepo(opts: { repoUrl?: string; readme?: string; description?: string }): Promise<RepoSummary> {
  const pasted = (opts.readme ?? "").trim();
  const desc = (opts.description ?? "").trim();
  if (opts.repoUrl?.trim()) {
    try {
      const r = await fetchRepo(opts.repoUrl);
      return summarize({ url: opts.repoUrl.trim(), name: r.meta.name, description: r.meta.description ?? desc, readme: r.readme || pasted, paths: r.paths, languages: r.languages, depFiles: r.depFiles, topics: r.meta.topics });
    } catch (e) {
      if (!pasted && !desc) throw e instanceof RepoError ? e : new RepoError("Couldn't read that repository. Paste your README instead.");
    }
  }
  if (!pasted && !desc) throw new RepoError("Give me a GitHub link, or paste your README or a short project description.");
  if ((pasted + desc).split(/\s+/).length < 15) throw new RepoError("That's a bit short for me to grill you on. Paste a few more lines: what it does, the stack, and how it's built.");
  return summarize({ url: opts.repoUrl?.trim() || null, description: desc, readme: pasted });
}
