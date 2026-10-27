// The tests' database holds every statement to the limit D1 sets on bound
// values, as the hosted registry's database does, so a statement that would
// fail on Cloudflare fails here too (test/setup.ts).
import { describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { workflow } from "@/db/schema";
import { BOUND_VALUES_LIMIT } from "@/db/rows";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);

describe("the tests' database", () => {
  it("runs a statement binding 100 values and refuses one binding 101, as D1 does", async () => {
    const db = await getDb();
    expect(BOUND_VALUES_LIMIT).toBe(100);
    expect(await db.select().from(workflow).where(inArray(workflow.id, ids(100)))).toEqual([]);
    await expect(db.select().from(workflow).where(inArray(workflow.id, ids(101)))).rejects.toThrow(
      "D1 binds at most 100 values in a statement, and this binds 101",
    );
  });
});
