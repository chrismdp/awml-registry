// Cloudflare Workers: no node:dns lookup and no way to choose the address a
// fetch connects to, so the name is resolved first, over DNS over HTTPS
// (node:dns on a Worker asks 1.1.1.1), and fetched only when every A and AAAA
// answer is a public address. A Worker's fetch cannot refuse a redirect, so
// it hands the redirect back unfollowed, and Better Auth refuses anything
// but a 200.
import { promises as dns } from "node:dns";
import { isPublicRoutableHost } from "@better-auth/core/utils/host";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";

const isIpLiteral = (host: string) => host.startsWith("[") || /^[\d.]+$/.test(host);

async function addresses(host: string) {
  if (isIpLiteral(host)) return [host];
  const answers = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host)]);
  return answers.flatMap((a) => (a.status === "fulfilled" ? a.value : []));
}

export const metadataTransport: ClientMetadataResourceFetch = async (input, init) => {
  const request = new Request(input, { ...init, redirect: "manual" });
  const url = new URL(request.url);
  if (url.protocol !== "https:") throw new TypeError("A client's metadata is fetched over https only");
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new TypeError("A client's metadata is fetched with GET or HEAD only");
  const found = isPublicRoutableHost(url.hostname) ? await addresses(url.hostname) : [];
  if (!found.length || !found.every(isPublicRoutableHost))
    throw new TypeError("A client's metadata address must resolve only to public addresses");
  return fetch(request);
};
