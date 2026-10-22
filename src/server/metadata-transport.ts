// Node (`next dev`, the Docker container): Better Auth's own transport. It
// resolves the name once, refuses unless every address is public, connects to
// that address and no other, and hands back a redirect without following it.
// The Cloudflare build swaps this module for metadata-transport.cloudflare.ts
// (see next.config.ts).
export { fetchClientMetadataResource as metadataTransport } from "@better-auth/cimd/node";
