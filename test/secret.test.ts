import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "@/instrumentation";

const before = { secret: process.env.BETTER_AUTH_SECRET, runtime: process.env.NEXT_RUNTIME };

const setEnv = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

// Starts the registry as a Node.js server does, with the secret given, and
// gives what it printed if it stopped, or null if it started.
async function startWith(secret: string | undefined) {
  setEnv("BETTER_AUTH_SECRET", secret);
  setEnv("NEXT_RUNTIME", "nodejs");
  const said = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
  try {
    await register();
    return null;
  } catch (stopped) {
    expect(String(stopped)).toContain("exit 1");
    return said.mock.calls.join(" ");
  } finally {
    exit.mockRestore();
    said.mockRestore();
  }
}

afterEach(() => {
  setEnv("BETTER_AUTH_SECRET", before.secret);
  setEnv("NEXT_RUNTIME", before.runtime);
});

describe("starting the registry", () => {
  it("stops without BETTER_AUTH_SECRET, saying how to make one", async () => {
    expect(await startWith(undefined)).toMatch(/BETTER_AUTH_SECRET is not set.*openssl rand -base64 32/);
    expect(await startWith("")).toMatch(/BETTER_AUTH_SECRET is not set.*openssl rand -base64 32/);
  });

  it("stops with the example's change-me", async () => {
    expect(await startWith("change-me")).toMatch(/change-me.*openssl rand -base64 32/);
  });

  it("stops with a secret under 32 characters", async () => {
    expect(await startWith("a".repeat(31))).toMatch(/only 31 characters.*openssl rand -base64 32/);
  });

  it("starts with a secret of 32 characters or more", async () => {
    expect(await startWith("a".repeat(32))).toBeNull();
    expect(await startWith("8yJ3qXnVd0r6mWcT1sLpZb4uKe9hAfGo2NiR5tYwQx=")).toBeNull();
  });
});
