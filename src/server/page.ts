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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A moment's day and time in UK time, as numbers.
function inLondon(d: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, Number(p.value)]),
  );
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute };
}

// A moment in UK time, as the Versions lists and Settings say when something
// happened: "Today 4:43pm", "Yesterday 9:12am", or "18 Oct 2026, 9:12am".
export function ukTime(at: Date, now = new Date()) {
  const t = inLondon(at);
  const clock = `${t.hour % 12 || 12}:${String(t.minute).padStart(2, "0")}${t.hour < 12 ? "am" : "pm"}`;
  const today = inLondon(now);
  // The calendar day before today's, worked out on the calendar, not by
  // taking 24 hours away, so a change of the clocks doesn't move it.
  const before = new Date(Date.UTC(today.year, today.month - 1, today.day - 1));
  const sameDay = (y: number, m: number, d: number) => t.year === y && t.month === m && t.day === d;
  if (sameDay(today.year, today.month, today.day)) return `Today ${clock}`;
  if (sameDay(before.getUTCFullYear(), before.getUTCMonth() + 1, before.getUTCDate())) return `Yesterday ${clock}`;
  return `${t.day} ${MONTHS[t.month - 1]} ${t.year}, ${clock}`;
}

// For a page under an owner that found nothing: when the owner is a name its
// person gave up, sends the visitor for good (308) to the same page, `before`
// the owner and `rest` after it, under the name they go by now. The page
// there makes its own check, so a private workflow stays a 404 to anyone
// outside.
export async function followOldName(db: Db, owner: string, rest = "", before = "") {
  const now = await renamedTo(db, owner);
  if (!now) return;
  permanentRedirect(`${before}/${now}${rest}`);
}

// A workflow's page shows one of its files drawn, all of them as text, or
// what checking them found.
export type PageView = View | "yaml" | "checks";
export const isPageView = (value: unknown): value is PageView =>
  value === "yaml" || value === "checks" || (VIEWS as readonly unknown[]).includes(value);

// The address of a workflow's page: its latest version or version `n`, and
// one view, or none for the page's own address, which shows the first view
// it has. Each part is kept inside its own segment.
export const workflowPath = (owner: string, slug: string, n: string | number, view?: PageView) =>
  `/${encodeURIComponent(owner)}${underOwner(slug, n, view)}`;

// The same address after the owner.
export const underOwner = (slug: string, n: string | number, view?: string) =>
  [slug, ...(n === "latest" ? [] : ["v", String(n)]), ...(view ? [view] : [])]
    .map((part) => `/${encodeURIComponent(part)}`)
    .join("");

// A platform's page shows what it offers, its install recipe, or its
// description as text.
export type PlatformTab = "offers" | "recipe" | "yaml";

// The address of a platform's page: its latest version or version `n`, and
// one tab, or none for what it offers. Each part is kept inside its own
// segment. The address reads as the reference AWML gives a platform,
// `owner/platforms/slug`.
export const platformPath = (owner: string, slug: string, n: string | number, tab: PlatformTab = "offers") =>
  `/${encodeURIComponent(owner)}/platforms${underOwner(slug, n, tab === "offers" ? undefined : tab)}`;
