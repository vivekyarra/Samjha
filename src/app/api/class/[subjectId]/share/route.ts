import QRCode from "qrcode";
import { handler, requireUser } from "@/lib/auth";
import { shareSubject, joinUrl, appOrigin } from "@/lib/class";

/** Owner only: share the subject. Returns join code, link and a QR code data URL. */
export const POST = handler(async (req: Request, { params }: { params: Promise<{ subjectId: string }> }) => {
  const user = await requireUser();
  const { subjectId } = await params;
  const { code } = await shareSubject(user.id, subjectId);
  const url = joinUrl(appOrigin(req.headers), code);
  const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320, errorCorrectionLevel: "M" });
  return Response.json({ code, joinUrl: url, qrDataUrl });
});
