// An AI client may name itself by the https address of its client ID metadata
// document (CIMD), as Claude.ai's custom connectors do, instead of registering.
// Better Auth's cimd plugin fetches that document through fetchClientMetadata,
// refusing an address that is not public, giving up after five seconds and
// reading at most 5 KB. The transport under it, one per platform, reaches only
// public addresses and never follows a redirect: metadata-transport.ts in
// Node, metadata-transport.cloudflare.ts on a Worker (see next.config.ts).
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { metadataTransport } from "@/server/metadata-transport";

let override: ClientMetadataResourceFetch | undefined;

// Tests stand in for the internet here.
export function setMetadataTransport(transport: ClientMetadataResourceFetch | undefined) {
  override = transport;
}

// The plugin times a fetch out by aborting its signal. A transport still
// resolving the name does not hear that, so the fetch stops waiting for it.
export const fetchClientMetadata: ClientMetadataResourceFetch = (input, init) => {
  const fetched = Promise.resolve((override ?? metadataTransport)(input, init));
  const signal = init?.signal;
  if (!signal) return fetched;
  const stopped = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  return Promise.race([fetched, stopped]);
};
