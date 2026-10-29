import { extHandler, extUser, preflight } from "../_shared";

export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

export const GET = extHandler(async (req) => {
  const u = await extUser(req);
  return Response.json(u ? { signedIn: true, name: u.name } : { signedIn: false, name: null });
});
