import { getDb } from "@/db/client";
import type { Params } from "@/server/http";
import { PLATFORM_FILES, readPlatformVersion } from "@/server/platforms";
import { oldNameRedirect } from "@/server/usernames";
import { requestViewer } from "@/server/viewer";

const plain = (status: number, ...lines: string[]) => new Response(`${lines.join("\n")}\n`, { status });

// One file of a platform version: its description as YAML, or its install
// recipe as Markdown.
export async function GET(req: Request, { params }: Params<"owner" | "slug" | "n" | "file">) {
  const { owner, slug, n, file } = await params;
  const moved = await oldNameRedirect(req, owner, "/platforms/");
  if (moved) return moved;
  const asker = await requestViewer(req.headers);
  if (!asker.ok) return plain(asker.status, ...asker.errors);
  if (!Object.hasOwn(PLATFORM_FILES, file)) return plain(404, "Not found.");
  const { field, type } = PLATFORM_FILES[file as keyof typeof PLATFORM_FILES];
  const found = await readPlatformVersion(await getDb(), asker.viewer, owner, slug, n);
  const text = found?.[field];
  if (typeof text !== "string") return plain(404, "Not found.");
  return new Response(text, {
    headers: {
      "content-type": type,
      "content-disposition": `inline; filename="${slug}-v${found!.number}-${file}"`,
    },
  });
}
