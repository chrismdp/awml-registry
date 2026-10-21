import { getAuth } from "@/server/auth";
import { siteUrl } from "@/server/http";

export async function POST(req: Request) {
  const res = await (await getAuth()).api.signOut({ headers: req.headers, asResponse: true });
  const out = Response.redirect(siteUrl(req, "/"), 303);
  const headers = new Headers(out.headers);
  for (const c of res.headers.getSetCookie()) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}
