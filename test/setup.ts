import { afterEach, beforeEach, vi } from "vitest";
import { setDb } from "@/db/client";
import { openSqlite } from "@/db/driver";
import { BOUND_VALUES_LIMIT } from "@/db/rows";
import { setMetadataTransport } from "@/server/client-metadata";
import { setEmailSender } from "@/server/email";
import { sentEmails, statements } from "./helpers";
import { pageRequest } from "./pages";

vi.mock("next/headers", () => ({
  headers: async () => pageRequest.headers,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret-0123";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS = "true";

// Every statement a test sends is held to D1's limit on bound values, which
// better-sqlite3 doesn't have, so a statement that would fail on Cloudflare
// fails here too; and each is kept, so a test can see what was asked.
const asD1 = {
  logQuery(query: string, params: unknown[]) {
    if (params.length > BOUND_VALUES_LIMIT)
      throw new Error(`D1 binds at most ${BOUND_VALUES_LIMIT} values in a statement, and this binds ${params.length}: ${query}`);
    statements.push(query);
  },
};

beforeEach(() => {
  setDb(openSqlite(":memory:", asD1));
  statements.length = 0;
  sentEmails.length = 0;
  setEmailSender({
    async sendMagicLink(to, url) {
      sentEmails.push({ to, url });
    },
  });
});

afterEach(() => {
  setDb(undefined);
  setMetadataTransport(undefined);
});
