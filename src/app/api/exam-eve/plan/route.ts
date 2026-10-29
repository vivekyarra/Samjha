import { z } from "zod";
import { handler, requireUser, canAccessSubject } from "@/lib/auth";
import { logEvent } from "@/lib/db";
import { planExamEve, type Budget } from "@/lib/exameve";

const Body = z.object({
  subjectId: z.string().min(1).nullish(),
  budgetMin: z.coerce.number().refine((n) => n === 5 || n === 10 || n === 20, "budgetMin must be 5, 10 or 20").default(5),
});

async function plan(userId: string, input: unknown) {
  const parsed = Body.safeParse(input);
  if (!parsed.success) return Response.json({ error: "Budget must be 5, 10 or 20 minutes" }, { status: 400 });
  const subjectId = parsed.data.subjectId ?? null;
  if (subjectId && !await canAccessSubject(userId, subjectId)) return Response.json({ error: "No access" }, { status: 403 });
  const result = await planExamEve(userId, subjectId, parsed.data.budgetMin as Budget);
  await logEvent(userId, "exam_eve_plan", { subjectId, budgetMin: parsed.data.budgetMin, topics: result.topics.length });
  return Response.json(result);
}

export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  const sp = new URL(req.url).searchParams;
  return plan(user.id, { subjectId: sp.get("subjectId") || null, budgetMin: sp.get("budget") ?? sp.get("budgetMin") ?? 5 });
});

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  return plan(user.id, await req.json().catch(() => ({})));
});
