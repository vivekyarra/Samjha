import { handler, currentUser, canAccessSubject } from "@/lib/auth";
import { rateLimit } from "@/lib/ratelimit";
import { classView, subjectFromToken, reportToken, appOrigin } from "@/lib/class";
import { buildReportPdf } from "@/lib/class/pdf";

/** One-page professor PDF. Access: a member (cookie) or anyone holding the report token (?token=). */
export const GET = handler(async (req: Request, { params }: { params: Promise<{ subjectId: string }> }) => {
  const { subjectId } = await params;
  const token = new URL(req.url).searchParams.get("token");
  const user = await currentUser();
  const byToken = !!token && await subjectFromToken(token) === subjectId;
  const byMember = !!user && await canAccessSubject(user.id, subjectId);
  if (!byToken && !byMember) return Response.json({ error: "Not allowed" }, { status: user ? 403 : 401 });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!await rateLimit(`class-pdf:${user?.id ?? ip}`, 60, 3600)) return Response.json({ error: "Too many downloads. Try again later." }, { status: 429 });

  const view = await classView(user?.id ?? null, subjectId);
  if (!view) return Response.json({ error: "Subject not found" }, { status: 404 });
  const link = `${appOrigin(req.headers)}/report/${reportToken(subjectId)}`;
  const bytes = await buildReportPdf({ heatmap: view.heatmap, misunderstood: view.misunderstood, link });
  const name = view.subject.name.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "class";
  return new Response(Buffer.from(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="samjha-class-report-${name}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
});
