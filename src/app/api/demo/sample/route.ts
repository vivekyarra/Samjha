// POST /api/demo/sample → adds the sample ML notes for the signed-in user (onboarding "use sample notes").
import { handler, requireUser } from "@/lib/auth";
import { logEvent } from "@/lib/db";
import { findSampleSubject, prepareSampleSubject } from "@/lib/demo/sample";

export const POST = handler(async () => {
  const user = await requireUser();
  const sample = await findSampleSubject(user.id) ?? await prepareSampleSubject(user.id, { history: !!user.is_demo, classmates: !!user.is_demo });
  await logEvent(user.id, "sample_notes_used", { subjectId: sample.subjectId });
  return Response.json({ subjectId: sample.subjectId, topicId: sample.topicIds["Gradient Descent"], topicName: "Gradient Descent" });
});
