import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins/jwt";
import { magicLink } from "better-auth/plugins/magic-link";
import { getDb, type Db } from "@/db/client";
import * as schema from "@/db/schema";
import { fetchClientMetadata } from "./client-metadata";
import { getEmailSender } from "./email";
import { mcpUrl } from "./http";
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
        jwks: schema.jwks,
        oauthClient: schema.oauthClient,
        oauthResource: schema.oauthResource,
        oauthClientResource: schema.oauthClientResource,
        oauthRefreshToken: schema.oauthRefreshToken,
        oauthAccessToken: schema.oauthAccessToken,
        oauthConsent: schema.oauthConsent,
        oauthClientAssertion: schema.oauthClientAssertion,
      },
    }),
    user: {
      additionalFields: { username: { type: "string", required: false, input: false } },
    },
    socialProviders,
    // The JWT plugin's own /token hands a session a JWT; the MCP plugin's
    // /oauth2/token is the only token endpoint the registry needs.
    disabledPaths: ["/token"],
    plugins: [
      magicLink({
        expiresIn: 60 * 15,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }) => (await getEmailSender()).sendMagicLink(email, url),
      }),
      // Signs the access tokens an AI client gets for /mcp.
      jwt(),
      // An OAuth 2.1 provider for /mcp: an AI client registers itself, sends
      // the person to the sign-in page and then the consent page, and gets a
      // token that acts as them on /mcp only.
      mcp({
        loginPage: "/login",
        consentPage: "/consent",
        resource: mcpUrl(),
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // A client calling back to localhost, as Claude Code and Codex do, is
        // a native app; one calling back to https, as Claude.ai and ChatGPT
        // do, is a web app.
        clientRegistrationDefaultApplicationType: "infer",
      }),
      // Or the client names itself by the https address of its metadata
      // document, and the registry fetches it (see client-metadata.ts).
      cimd({ fetchClientMetadataResource: fetchClientMetadata, metadataProfile: "mcp-2026-07-28" }),
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
