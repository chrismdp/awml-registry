import { headers } from "next/headers";
import { permanentRedirect } from "next/navigation";
import { getDb, type Db } from "@/db/client";
import { VIEWS, type View } from "./registry";
import { renamedTo } from "./usernames";
import { getViewer } from "./viewer";

// The signed-in user for a page, and the database.
export async function pageContext() {
  const [db, viewer] = await Promise.all([getDb(), headers().then(getViewer)]);
  return { db, viewer };
}

export const dateTime = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";

// For a page under an owner that found nothing: when the owner is a name its
// person gave up, sends the visitor for good (308) to the same page, `rest`
// after the owner, under the name they go by now. The page there makes its
// own check, so a private workflow stays a 404 to anyone outside.
export async function followOldName(db: Db, owner: string, rest = "") {
  const now = await renamedTo(db, owner);
  if (!now) return;
  permanentRedirect(`/${now}${rest}`);
}

// A workflow's page shows one of its files drawn, or all of them as text.
export type PageView = View | "yaml";
export const isPageView = (value: unknown): value is PageView =>
  value === "yaml" || (VIEWS as readonly unknown[]).includes(value);

// The address of a workflow's page: its latest version or version `n`, and
// one view, or none for the page's own address, which shows the first view
// it has. Each part is kept inside its own segment.
export const workflowPath = (owner: string, slug: string, n: string | number, view?: PageView) =>
  `/${encodeURIComponent(owner)}${underOwner(slug, n, view)}`;

// The same address after the owner.
export const underOwner = (slug: string, n: string | number, view?: PageView) =>
  [slug, ...(n === "latest" ? [] : ["v", String(n)]), ...(view ? [view] : [])]
    .map((part) => `/${encodeURIComponent(part)}`)
    .join("");
