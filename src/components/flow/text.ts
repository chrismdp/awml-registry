import { INTER_ASCENT, INTER_DESCENT, INTER_WIDTHS } from "./inter-widths";

// How wide text is in the Inter the registry serves, and where it breaks into
// lines, worked out without a browser, so the server can size a drawing's
// boxes. Each label is drawn line by line as broken here, so a browser never
// breaks it differently. Kerning is left out, which errs wide, so a line
// always fits its box.

// A character the table doesn't have, such as an emoji, is taken as one em.
const UNKNOWN = 1000;

export function textWidth(text: string, size: number) {
  let total = 0;
  for (const ch of text) total += INTER_WIDTHS[ch.codePointAt(0)!] ?? UNKNOWN;
  return (total * size) / 1000;
}

// Where the first baseline sits below the top of a line `line` pixels high,
// as a browser places it.
export function baseline(size: number, line: number) {
  return (line - (INTER_ASCENT + INTER_DESCENT) * size) / 2 + INTER_ASCENT * size;
}

// `text` in lines no wider than `max`, broken between words, or inside a word
// too long for a line on its own.
export function wrap(text: string, size: number, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, size) <= max) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    let rest = word;
    while (textWidth(rest, size) > max) {
      let cut = 1;
      while (cut < rest.length && textWidth(rest.slice(0, cut + 1), size) <= max) cut++;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

// The widest of some lines.
export const widest = (lines: string[], size: number) => Math.max(0, ...lines.map((l) => textWidth(l, size)));
