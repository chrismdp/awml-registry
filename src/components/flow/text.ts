import { INTER_ASCENT, INTER_DESCENT, INTER_WIDTHS } from "./inter-widths";

// How wide text is in the Inter the registry serves, and where it breaks into
// lines, worked out without a browser, so the server can size a drawing's
// boxes. Each label is drawn line by line as broken here, so a browser never
// breaks it differently. Kerning is left out, which errs wide, so a line
// always fits its box.

// A character the table doesn't have, such as an emoji, is taken as one em.
const UNKNOWN = 1000;

const charWidth = (ch: string, size: number) => ((INTER_WIDTHS[ch.codePointAt(0)!] ?? UNKNOWN) * size) / 1000;

export function textWidth(text: string, size: number) {
  let total = 0;
  for (const ch of text) total += charWidth(ch, size);
  return total;
}

// Where the first baseline sits below the top of a line `line` pixels high,
// as a browser places it.
export function baseline(size: number, line: number) {
  return (line - (INTER_ASCENT + INTER_DESCENT) * size) / 2 + INTER_ASCENT * size;
}

// `text` in lines no wider than `max`, broken between words, or inside a word
// too long for a line on its own. Each character is measured once, so a long
// label takes no longer than its length.
export function wrap(text: string, size: number, max: number): string[] {
  const space = charWidth(" ", size);
  const lines: string[] = [];
  let line = "";
  let width = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const w = textWidth(word, size);
    if (line && width + space + w <= max) {
      line += ` ${word}`;
      width += space + w;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    width = 0;
    if (w <= max) {
      line = word;
      width = w;
      continue;
    }
    for (const ch of word) {
      const cw = charWidth(ch, size);
      if (line && width + cw > max) {
        lines.push(line);
        line = "";
        width = 0;
      }
      line += ch;
      width += cw;
    }
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

// The widest of some lines.
export const widest = (lines: string[], size: number) => Math.max(0, ...lines.map((l) => textWidth(l, size)));
