import { siteUrl, type Params } from "@/server/http";

// A platform version's files were here until 2026-10-22, when the
// platform's pages moved to /{owner}/platforms/{slug}. An old address goes
// for good (308) to the same file there, query kept, without looking, so it
// says nothing about whether the platform exists. The file there makes its
// own check.
export async function GET(req: Request, { params }: Params<"owner" | "slug" | "n" | "file">) {
  const { owner, slug, n, file } = await params;
  const path = [owner, "platforms", slug, "v", n, file].map((part) => `/${encodeURIComponent(part)}`).join("");
  return Response.redirect(siteUrl(req, path + new URL(req.url).search), 308);
}
