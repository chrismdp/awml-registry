import { afterEach, beforeEach } from "vitest";
import { setDb } from "@/db/client";
import { openSqlite } from "@/db/driver";
import { setEmailSender } from "@/server/email";
import { sentEmails } from "./helpers";

process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret-0123";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";

beforeEach(() => {
  setDb(openSqlite(":memory:"));
  sentEmails.length = 0;
  setEmailSender({
    async sendMagicLink(to, url) {
      sentEmails.push({ to, url });
    },
  });
});

afterEach(() => {
  setDb(undefined);
});
