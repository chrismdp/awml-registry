// An AI client may name itself by the https address of its client ID metadata
// document, which the registry then fetches. That fetch reaches only public
// addresses, follows no redirect, gives up after five seconds and reads at
// most 5 KB, in Node (the Docker image) and on Cloudflare Workers alike.
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchClientMetadata } from "@/server/client-metadata";
import { metadataTransport as workerTransport } from "@/server/metadata-transport.cloudflare";
import { setMetadataTransport } from "@/server/client-metadata";
import { request } from "./helpers";
import { authorisationRequest, CIMD_CLIENT, clientMetadata, serveMetadata } from "./mcp-client";

// The Worker transport asks DNS through node:dns, which these tests answer.
const dns = vi.hoisted(() => ({ resolve4: vi.fn(), resolve6: vi.fn() }));
vi.mock("node:dns", () => ({ promises: dns, default: { promises: dns } }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  dns.resolve4.mockReset();
  dns.resolve6.mockReset();
});

// A client starting to sign in, as far as the registry fetching its metadata.
async function authorise(clientId: string) {
  const { query } = await authorisationRequest(clientId);
  return request("GET", `/api/auth/oauth2/authorize?${query}`);
}

// The registry refused the client, with the reason, rather than sending the
// person on to sign in.
async function expectRefused(res: Response, reason: RegExp) {
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe("invalid_client");
  expect(body.error_description).toMatch(reason);
}

const PRIVATE = [
  "https://127.0.0.1/client.json",
  "https://localhost/client.json",
  "https://app.localhost/client.json",
  "https://10.0.0.5/client.json",
  "https://172.16.0.1/client.json",
  "https://192.168.1.2/client.json",
  "https://169.254.169.254/latest/meta-data/client.json",
  "https://metadata.google.internal/client.json",
  "https://[::1]/client.json",
  "https://[fe80::1]/client.json",
  "https://[fd00::1]/client.json",
];

describe("signing in with a client ID metadata document", () => {
  it("refuses a client whose document is at a private, loopback or link-local address, and fetches nothing", async () => {
    const asked = serveMetadata({});
    for (const clientId of PRIVATE) await expectRefused(await authorise(clientId), /private or reserved address/);
    expect(asked).toEqual([]);
  });

  it("refuses a document that redirects, and never fetches where it points", async () => {
    const asked: string[] = [];
    setMetadataTransport(async (input) => {
      asked.push(new Request(input).url);
      return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } });
    });
    await expectRefused(await authorise(CIMD_CLIENT), /HTTP 302/);
    expect(asked).toEqual([CIMD_CLIENT]);
  });

  it("refuses a document over 5 KB, and stops reading one that never ends", async () => {
    serveMetadata({ [CIMD_CLIENT]: { ...clientMetadata(), padding: "x".repeat(6 * 1024) } });
    await expectRefused(await authorise(CIMD_CLIENT), /exceeds 5KB/);

    let sent = 0;
    let cancelled = false;
    setMetadataTransport(async () => {
      const endless = new ReadableStream<Uint8Array>({
        pull(controller) {
          sent += 1024;
          controller.enqueue(new TextEncoder().encode(" ".repeat(1024)));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(endless, { headers: { "content-type": "application/json" } });
    });
    await expectRefused(await authorise("https://ai-client.test/oauth/endless.json"), /exceeds 5KB/);
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThanOrEqual(8 * 1024);
  });

  it("gives up after five seconds, even on a fetch that ignores being told to stop", async () => {
    let reached!: () => void;
    const fetching = new Promise<void>((resolve) => (reached = resolve));
    setMetadataTransport(() => {
      reached();
      return new Promise<Response>(() => {});
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = authorise(CIMD_CLIENT);
    await fetching;
    await vi.advanceTimersByTimeAsync(5000);
    await expectRefused(await pending, /timed out after 5000ms/);
  });
});

describe("the fetch in Node, as in the Docker image", () => {
  it("refuses a name that resolves to this machine or a private address, and never connects", async () => {
    let connections = 0;
    const server = net.createServer((socket) => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      for (const url of [
        `https://localhost:${port}/client.json`,
        `https://127.0.0.1:${port}/client.json`,
        `https://10.0.0.5:${port}/client.json`,
        `https://169.254.169.254:${port}/client.json`,
      ])
        await expect(fetchClientMetadata(url, { headers: { accept: "application/json" } }), url).rejects.toThrow(
          /public-routable/,
        );
      expect(connections).toBe(0);
    } finally {
      server.close();
    }
  });
});

describe("the fetch on Cloudflare Workers", () => {
  const fetched: Request[] = [];
  function stubFetch(answer: () => Response) {
    fetched.length = 0;
    vi.stubGlobal("fetch", async (req: Request) => {
      fetched.push(req);
      return answer();
    });
  }
  const answers = (v4: string[], v6: string[]) => {
    dns.resolve4.mockResolvedValue(v4);
    if (v6.length) dns.resolve6.mockResolvedValue(v6);
    else dns.resolve6.mockRejectedValue(Object.assign(new Error("no AAAA"), { code: "ENODATA" }));
  };

  it("refuses a name whose DNS answers include a private, loopback or link-local address, and fetches nothing", async () => {
    stubFetch(() => Response.json(clientMetadata()));
    for (const [v4, v6] of [
      [["10.0.0.5"], []],
      [["127.0.0.1"], []],
      [["169.254.169.254"], []],
      [["93.184.215.14"], ["::1"]],
      [["93.184.215.14", "192.168.0.10"], []],
      [[], ["fe80::1"]],
      [[], []],
    ]) {
      answers(v4, v6);
      await expect(workerTransport(CIMD_CLIENT, {}), `${v4} ${v6}`).rejects.toThrow(/public/);
    }
    for (const url of PRIVATE) await expect(workerTransport(url, {}), url).rejects.toThrow(/public/);
    expect(fetched).toEqual([]);
  });

  it("fetches a name whose answers are all public, once, and hands back a redirect without following it", async () => {
    answers(["93.184.215.14"], ["2606:2800:21f:cb07:6820:80da:af6b:8b2c"]);
    stubFetch(() => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } }));
    const res = await workerTransport(CIMD_CLIENT, { redirect: "error", headers: { accept: "application/json" } });
    expect(res.status).toBe(302);
    expect(fetched.map((r) => [r.url, r.redirect, r.method])).toEqual([[CIMD_CLIENT, "manual", "GET"]]);
    expect(dns.resolve4).toHaveBeenCalledWith("ai-client.test");
  });

  it("refuses anything but an https GET", async () => {
    answers(["93.184.215.14"], []);
    stubFetch(() => Response.json(clientMetadata()));
    await expect(workerTransport("http://ai-client.test/oauth/client.json", {})).rejects.toThrow(/https/);
    await expect(workerTransport(CIMD_CLIENT, { method: "POST", body: "{}" })).rejects.toThrow(/GET/);
    expect(fetched).toEqual([]);
  });
});
