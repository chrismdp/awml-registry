// An AI client of /mcp, as the tests play it: JSON-RPC over HTTP, and
// connecting with OAuth through the sign-in and consent pages, by dynamic
// client registration or with a client ID metadata document.
import { expect } from "vitest";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { setMetadataTransport } from "@/server/client-metadata";
import LoginPage from "@/app/login/page";
import ConsentPage from "@/app/consent/page";
import { BASE, request } from "./helpers";
import { renderPage } from "./pages";
import { route } from "./router";

export const MCP = `${BASE}/mcp`;

type Message = {
  result?: { content: { type: string; text: string }[]; structuredContent?: unknown; isError?: boolean } & Record<
    string,
    unknown
  >;
  error?: { code: number; message: string };
};

// One JSON-RPC request to /mcp, as an MCP client sends it over streamable HTTP.
export async function post(method: string, params: unknown, bearer?: string) {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
  });
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  return route(
    new Request(MCP, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }),
  );
}

// The JSON-RPC message in a response, sent as JSON or as a server-sent event.
export async function message(res: Response): Promise<Message> {
  const text = await res.text();
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return JSON.parse(text);
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  return JSON.parse(data.at(-1)!);
}

// A tool's answer: its text, its structured content, and whether it refused.
export type Answer = { text: string; data: any; isError: boolean };

export async function call(tool: string, args: Record<string, unknown>, bearer?: string): Promise<Answer> {
  const res = await post("tools/call", { name: tool, arguments: args }, bearer);
  expect(res.status, `${tool} answered ${res.status}`).toBe(200);
  const { result, error } = await message(res);
  if (error || !result) throw new Error(error?.message ?? "no result");
  return {
    text: result.content.map((c) => c.text).join("\n"),
    data: result.structuredContent,
    isError: Boolean(result.isError),
  };
}

// A page's search params as Next.js gives them: a repeated key as a list.
export function searchOf(url: URL) {
  const search: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams) {
    const had = search[key];
    search[key] = had === undefined ? value : [had, value].flat();
  }
  return search;
}

export const CALLBACK = "http://localhost:33418/callback";

// A client that names itself by the address of its metadata document, as
// Claude.ai's custom connectors do.
export const CIMD_CLIENT = "https://ai-client.test/oauth/client.json";

export const clientMetadata = (clientId = CIMD_CLIENT, name = "Test AI") => ({
  client_id: clientId,
  client_name: name,
  redirect_uris: [CALLBACK],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
});

// Stands in for the internet when the registry fetches a client's metadata
// document: answers each address given with its document, anything else with
// a 404, and keeps every address asked for.
export function serveMetadata(documents: Record<string, unknown> = { [CIMD_CLIENT]: clientMetadata() }) {
  const asked: string[] = [];
  const transport: ClientMetadataResourceFetch = async (input) => {
    const url = new Request(input).url;
    asked.push(url);
    return url in documents ? Response.json(documents[url]) : new Response("Not found", { status: 404 });
  };
  setMetadataTransport(transport);
  return asked;
}

// The start of a client's authorisation request, with PKCE.
export async function authorisationRequest(clientId: string, opts: { resource?: string } = { resource: MCP }) {
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: Buffer.from(digest).toString("base64url"),
    code_challenge_method: "S256",
    scope: "openid offline_access",
    state: "s1",
    ...(opts.resource ? { resource: opts.resource } : {}),
  });
  return { query, verifier };
}

// Someone connecting an AI client the way Claude.ai or Claude Code does: the
// client registers itself, or names its metadata document as its client id,
// sends them to sign in and allow it, and swaps the code it gets back for an
// access token for /mcp and a refresh token.
export async function connect(
  who: { cookie: string },
  opts: { resource?: string; clientId?: string; name?: string } = {},
) {
  const resource = "resource" in opts ? opts.resource : MCP;
  let clientId = opts.clientId;
  if (!clientId) {
    const registered = await request("POST", "/api/auth/oauth2/register", {
      json: {
        client_name: opts.name ?? "Test AI",
        redirect_uris: [CALLBACK],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
    });
    expect(registered.status).toBe(201);
    clientId = (await registered.json()).client_id as string;
  }
  const { query, verifier } = await authorisationRequest(clientId, { resource });

  // Signed out, authorising sends them to the sign-in page.
  const toSignIn = await request("GET", `/api/auth/oauth2/authorize?${query}`);
  expect(toSignIn.status).toBe(302);
  const signInAt = new URL(toSignIn.headers.get("location")!, BASE);
  expect(signInAt.pathname).toBe("/login");

  // Once signed in, the sign-in page sends them back to finish authorising.
  const back = await renderPage(LoginPage, {}, { as: who, search: searchOf(signInAt) });
  expect(back.status).toBe(307);
  const toConsent = await request("GET", back.location!, { as: who });
  expect(toConsent.status).toBe(302);
  const consentAt = new URL(toConsent.headers.get("location")!, BASE);
  expect(consentAt.pathname).toBe("/consent");

  // The consent page names the client, and Allow posts this.
  const page = await renderPage(ConsentPage, {}, { as: who, search: searchOf(consentAt) });
  expect(page.status).toBe(200);
  expect(page.html).toContain(opts.name ?? "Test AI");
  const allowed = await route(
    new Request(`${BASE}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { cookie: who.cookie, origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ accept: true, oauth_query: consentAt.search.slice(1) }),
    }),
  );
  expect(allowed.status).toBe(200);
  const code = new URL((await allowed.json()).url).searchParams.get("code")!;

  const token = await request("POST", "/api/auth/oauth2/token", {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
      ...(resource ? { resource } : {}),
    },
  });
  expect(token.status).toBe(200);
  const body = await token.json();
  return { accessToken: body.access_token as string, refreshToken: body.refresh_token as string, clientId };
}

// A client swapping its refresh token for a new access token.
export function refresh(clientId: string, refreshToken: string) {
  return request("POST", "/api/auth/oauth2/token", {
    form: { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, resource: MCP },
  });
}
