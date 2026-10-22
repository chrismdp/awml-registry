"use client";

import { useState } from "react";

// Copies `text` with the browser's clipboard. Where the page may not use it,
// as on an http address or in an older browser, or the browser refuses,
// `select` selects the text instead, so the person can copy it themselves.
// Gives what to tell them.
export async function copyText(
  text: string,
  clipboard: Pick<Clipboard, "writeText"> | undefined,
  select: () => void,
): Promise<string> {
  try {
    if (!clipboard) throw new Error("No clipboard");
    await clipboard.writeText(text);
    return "Copied";
  } catch {
    select();
    return "Selected: press Ctrl+C or ⌘C to copy";
  }
}

// A Copy button for the text of the element with the id `target`.
export function CopyButton({ target }: { target: string }) {
  const [said, setSaid] = useState("");
  async function copy() {
    const element = document.getElementById(target);
    if (!element) return;
    const select = () => window.getSelection()?.selectAllChildren(element);
    setSaid(await copyText(element.textContent ?? "", navigator.clipboard, select));
  }
  return (
    <>
      <button type="button" className="button outline" aria-controls={target} onClick={copy}>
        Copy
      </button>
      <span role="status" className="copied">
        {said}
      </span>
    </>
  );
}
