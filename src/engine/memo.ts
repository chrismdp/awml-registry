// The engine's answers depend only on the files it is given and the AWML it
// runs, so the same files need working out only once per process or Worker
// isolate. A stored version never changes, and refs are checked against the
// latest files they name, which are among the arguments, so an answer kept
// here is never out of date. It is kept by the files themselves, so a caller
// only ever gets back what it would have worked out from files it holds.

// The arguments' SHA-256, which keeps a key small however big the files.
async function keyOf(args: unknown[]) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(args)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// `work`, answering arguments it was given before from the answer it gave
// then, keeping the `limit` most recently used. Each caller gets its own
// copy. A failure isn't kept.
export function memoise<A extends unknown[], R>(work: (...args: A) => Promise<R>, limit = 200) {
  const kept = new Map<string, Promise<R>>();
  return async (...args: A): Promise<R> => {
    const key = await keyOf(args);
    let answer = kept.get(key);
    if (answer) kept.delete(key);
    else {
      answer = work(...args);
      answer.catch(() => kept.get(key) === answer && kept.delete(key));
    }
    kept.set(key, answer);
    if (kept.size > limit) kept.delete(kept.keys().next().value!);
    return structuredClone(await answer);
  };
}
