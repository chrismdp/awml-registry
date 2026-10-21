import { getDb } from "@/db/client";
import type { Params } from "@/server/http";
import { readVersion, VIEWS, type View } from "@/server/registry";
import { getViewer } from "@/server/viewer";

const notFound = () => new Response("Not found.\n", { status: 404 });

export async function GET(req: Request, { params }: Params<"owner" | "slug" | "n" | "file">) {
  const { owner, slug, n, file } = await params;
  const view = file.replace(/\.yaml$/, "") as View;
  if (!file.endsWith(".yaml") || !VIEWS.includes(view)) return notFound();
  const found = await readVersion(await getDb(), await getViewer(req.headers), owner, slug, n);
  const text = found?.files[view];
  if (text === undefined) return notFound();
  return new Response(text, {
    headers: {
      "content-type": "application/yaml; charset=utf-8",
      "content-disposition": `inline; filename="${slug}-v${found!.number}-${view}.yaml"`,
    },
  });
}
