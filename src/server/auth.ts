import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins/magic-link";
import { getDb, type Db } from "@/db/client";
import * as schema from "@/db/schema";
import { getEmailSender } from "./email";
import { freeUsername } from "./slugs";

function makeAuth(db: Db) {
  const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    socialProviders.github = {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
    };
  }
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    socialProviders.google = {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    };
  }
  return betterAuth({
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    user: {
      additionalFields: { username: { type: "string", required: false, input: false } },
    },
    socialProviders,
    plugins: [
      magicLink({
        expiresIn: 60 * 15,
        storeToken: "hashed",
        sendMagicLink: ({ email, url }) => getEmailSender().sendMagicLink(email, url),
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          before: async (data) => ({
            data: { ...data, username: await freeUsername(db, data.email) },
          }),
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof makeAuth>;

const byDb = new WeakMap<Db, Auth>();

export async function getAuth(): Promise<Auth> {
  const db = await getDb();
  let auth = byDb.get(db);
  if (!auth) {
    auth = makeAuth(db);
    byDb.set(db, auth);
  }
  return auth;
}

export function socialProviderNames() {
  return [
    process.env.GITHUB_CLIENT_ID && "github",
    process.env.GOOGLE_CLIENT_ID && "google",
  ].filter(Boolean) as ("github" | "google")[];
}
