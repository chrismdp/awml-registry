import { getDb } from "@/db/client";
import type { Params } from "@/server/http";
import { readVersion, VIEWS, type View } from "@/server/registry";
import { requestViewer } from "@/server/viewer";

const plain = (status: number, ...lines: string[]) => new Response(`${lines.join("\n")}\n`, { status });

export async function GET(req: Request, { params }: Params<"owner" | "slug" | "n" | "file">) {
  const { owner, slug, n, file } = await params;
  const asker = await requestViewer(req.headers);
  if (!asker.ok) return plain(asker.status, ...asker.errors);
  const view = file.replace(/\.yaml$/, "") as View;
  if (!file.endsWith(".yaml") || !VIEWS.includes(view)) return plain(404, "Not found.");
  const found = await readVersion(await getDb(), asker.viewer, owner, slug, n);
  const text = found?.files[view];
  if (text === undefined) return plain(404, "Not found.");
  return new Response(text, {
    headers: {
      "content-type": "application/yaml; charset=utf-8",
      "content-disposition": `inline; filename="${slug}-v${found!.number}-${view}.yaml"`,
    },
  });
}
