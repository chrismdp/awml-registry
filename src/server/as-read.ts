// The engine reads only the AWML it was built for, and the registry keeps
// every file as it was pushed. So a file stored in an older AWML is
// converted with the engine's `convert` each time it is read, and never
// rewritten; a current file comes back unchanged.
import { engine, type Files } from "@/engine";

// A stored file as the engine reads it: converted, with what converting it
// noted for its author to do by hand, any mistakes its rules find being left
// to check; or the reasons it can't be converted. `awml convert` exits 1 when
// it notes something, and still writes the whole file, which is read.
export type AsRead = { file: string; notes: string[] } | { error: string[] };

async function converted(sources: string[]): Promise<AsRead> {
  const c = await engine.convert(sources);
  return "error" in c ? { error: c.error.split("\n") } : { file: c.file, notes: c.notes };
}

// One of a version's stored files as the engine reads it. A version stored
// before 0.4 converts its security view on its own, and its platform view
// only joined with the security view, which needs one with the same parts
// and lines.
export function asRead(files: Files, name: keyof Files): Promise<AsRead> {
  if (name === "platform" && files.workflow === undefined)
    return converted([files.security, files.platform].filter((f): f is string => f !== undefined));
  return converted([files[name]!]);
}

// The graph of the design drawn from one stored file for a card: a workflow,
// or a security view stored before 0.4. "" when the engine can't draw it, as
// for a platform view stored on its own, which doesn't convert. A drawing
// with errors is drawn, its errors red; an invalid file is not (#100).
export async function designGraph(stored: string) {
  const read = await converted([stored]);
  if ("error" in read || (await engine.unsound(read.file)).length) return "";
  return engine.graph(read.file);
}

// A stored platform description as the engine reads it. Each passed check
// when it was pushed, and converting changes only the version it says it is.
export async function descriptionAsRead(description: string) {
  const read = await converted([description]);
  if ("error" in read) throw new Error(read.error.join("\n"));
  return read.file;
}
