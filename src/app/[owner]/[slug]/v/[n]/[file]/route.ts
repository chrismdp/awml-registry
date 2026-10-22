import { getDb } from "@/db/client";
import type { Params } from "@/server/http";
import { FILES, readVersion, type FileName } from "@/server/registry";
import { oldNameRedirect } from "@/server/usernames";
import { requestViewer } from "@/server/viewer";

const plain = (status: number, ...lines: string[]) => new Response(`${lines.join("\n")}\n`, { status });

export async function GET(req: Request, { params }: Params<"owner" | "slug" | "n" | "file">) {
  const { owner, slug, n, file } = await params;
  const moved = await oldNameRedirect(req, owner, "/");
  if (moved) return moved;
  const asker = await requestViewer(req.headers);
  if (!asker.ok) return plain(asker.status, ...asker.errors);
  const name = file.replace(/\.yaml$/, "") as FileName;
  if (!file.endsWith(".yaml") || !FILES.includes(name)) return plain(404, "Not found.");
  const found = await readVersion(await getDb(), asker.viewer, owner, slug, n);
  const text = found?.files[name];
  if (text === undefined) return plain(404, "Not found.");
  return new Response(text, {
    headers: {
      "content-type": "application/yaml; charset=utf-8",
      "content-disposition": `inline; filename="${slug}-v${found!.number}-${name}.yaml"`,
    },
  });
}
