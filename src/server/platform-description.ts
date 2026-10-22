// What a platform description says, field by field in plain words, with the
// comment written above each field in the file, which is the evidence for
// its value. The file's top comment introduces the platform.
import { isMap, isScalar, parseDocument, type Pair } from "yaml";

export type OfferRow = { label: string; value: string; comment: string };

const list = (items: string[]) => new Intl.ListFormat("en-GB", { type: "conjunction" }).format(items);

const UNITS = [
  ["week", "weeks"],
  ["day", "days"],
  ["hour", "hours"],
  ["minute", "minutes"],
  ["second", "seconds"],
] as const;

// An ISO 8601 duration in words, in the weeks to seconds AWML allows: P14D
// is "14 days".
export function durationWords(iso: string) {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso);
  if (!m) return iso;
  const parts = m
    .slice(1)
    .map((n, i) => [Number(n ?? 0), UNITS[i]] as const)
    .filter(([n]) => n > 0)
    .map(([n, [one, many]]) => `${n} ${n === 1 ? one : many}`);
  return parts.length ? list(parts) : "no time: it is always on";
}

// A comment as the yaml library keeps it, one space after each #, as text.
const commentText = (c: string | null | undefined) =>
  (c ?? "")
    .split("\n")
    .map((line) => line.replace(/^ /, ""))
    .join("\n")
    .trim();

const names = (value: unknown, none: string, any?: string) =>
  value === "any" && any ? any : Array.isArray(value) && value.length ? list(value.map(String)) : none;

// The rows a platform's page shows, in the order the description's format
// gives them, and its top comment. A comment above the first field, with no
// blank line between, is the top comment too.
export function describePlatform(text: string): { intro: string; rows: OfferRow[] } {
  const doc = parseDocument(text);
  const pairs: Pair[] = isMap(doc.contents) ? doc.contents.items : [];
  const comments = new Map<string, string>();
  for (const pair of pairs) if (isScalar(pair.key)) comments.set(String(pair.key.value), commentText(pair.key.commentBefore));
  const first = pairs[0] && isScalar(pairs[0].key) ? String(pairs[0].key.value) : "";
  const intro = [commentText(doc.commentBefore), first === "awml" ? comments.get("awml") : ""].filter(Boolean).join("\n");
  const d = doc.toJS() as Record<string, unknown>;
  const row = (field: string, label: string, value: string) => ({ label, value, comment: comments.get(field) ?? "" });
  return {
    intro,
    rows: [
      row("off_for_up_to", "Off for up to", durationWords(String(d.off_for_up_to))),
      row("steps", "Runs steps as", d.steps === "agent" ? "an AI agent" : String(d.steps)),
      row("agents", "AI from", names(d.agents, "none")),
      row("calls", "Can call", names(d.calls, "none", "any company")),
      row("holds", "Holds", names(d.holds, "nothing")),
    ],
  };
}
