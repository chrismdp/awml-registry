// A stand-in for the AWML package until its WebAssembly build is ready. It
// refuses obvious garbage, counts parts by kind, and draws a plain flowchart.
// It does not hold a file to the AWML spec the way `awml check` does.
import { parse } from "yaml";
import type { Engine, Files, Summary } from "./types";

type Doc = {
  awml?: unknown;
  title?: unknown;
  view?: unknown;
  parts?: { id?: unknown; kind?: unknown; label?: unknown }[];
  lines?: { from?: unknown; to?: unknown; kind?: unknown; label?: unknown }[];
};

function read(yaml: string): { doc?: Doc; errors: string[] } {
  let doc: unknown;
  try {
    doc = parse(yaml);
  } catch (e) {
    return { errors: [`not YAML: ${(e as Error).message.split("\n")[0]}`] };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    return { errors: ["the file is not a YAML mapping"] };
  const d = doc as Doc;
  const errors: string[] = [];
  if (d.awml === undefined) errors.push("missing field: awml");
  if (typeof d.title !== "string") errors.push("missing field: title");
  if (d.view !== "security" && d.view !== "platform")
    errors.push(d.view === undefined ? "missing field: view" : `unknown view: ${String(d.view)}`);
  if (!Array.isArray(d.parts)) errors.push("missing field: parts");
  return { doc: d, errors };
}

const esc = (s: unknown) => String(s ?? "").replace(/"/g, "#quot;");

export const stubEngine: Engine = {
  async check(yaml) {
    return read(yaml).errors;
  },

  async summarise(files: Files): Promise<Summary> {
    const counts: Record<string, number> = {};
    // Parts appear in both views, so count them from one file only.
    const doc = read(files.security ?? files.platform ?? "").doc;
    for (const part of doc?.parts ?? []) {
      const kind = String(part.kind);
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    for (const line of doc?.lines ?? []) {
      if (line.kind === "publish" || line.kind === "refused") {
        const key = String(line.kind);
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    return { counts };
  },

  async draw(yaml) {
    const doc = read(yaml).doc;
    const out = ["flowchart TD"];
    for (const p of doc?.parts ?? []) out.push(`  ${p.id}["${esc(p.label ?? p.kind)}"]`);
    for (const l of doc?.lines ?? []) {
      if (l.kind === "hidden") continue;
      const arrow = l.kind === "publish" ? "==>" : l.kind === "start" || l.kind === "tie" ? "-.->" : "-->";
      out.push(l.label ? `  ${l.from} ${arrow}|"${esc(l.label)}"| ${l.to}` : `  ${l.from} ${arrow} ${l.to}`);
    }
    return out.join("\n");
  },
};
