// The data the build workflow puts in a fresh registry before it pictures its pages, so the
// pictures of main and of a change show the same people, workflows and platforms. It goes through
// the registry's HTTP API, as a person's browser and the CLI do, and needs nothing but Node:
//   node --experimental-strip-types scripts/seed-pictures.ts --base http://localhost:3100 \
//     --log server.log
// It signs in with email links. A registry without email set up prints each link to its log, so
// the script reads the links from the server's log. It prints ana's session cookie, for the
// pictures of pages seen signed in.
//
// What it makes:
// - ana (ana@example.com) and ben (ben@example.com);
// - acme, an organisation that ana owns, with ben as a member;
// - acme/dinners, public, at two versions: the AWML 0.4 file, then the 0.5 one;
// - acme/client-email, public;
// - acme/shopping, public, whose favourites refer to dinners.yaml#favourites, stored as
//   acme/dinners#favourites, so acme/dinners is referred to by it;
// - acme/pantry, public, a copy of acme/shopping under another title, so dinners' favourites are
//   referred to by two workflows and their mark opens a menu;
// - ana/dinners, private;
// - ana/family-dinners, public, a fork of acme/dinners at version 1;
// - acme/platforms/worker, public, at two versions: without an install recipe, then with one;
// - acme/platforms/codex-laptop, public;
// - acme/platforms/cowork-mac-mini, private;
// - acme/systems/kitchen, public, holding acme/dinners, acme/shopping and ana's private
//   ana/dinners, so a visitor sees "1 private workflow" where ana sees all three.
//
// A change that needs more data to show adds it here. The pictures of main use main's copy of
// this file, and the pictures of the change use the change's copy.
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export type SeedOptions = {
  // The registry's address, as its BETTER_AUTH_URL gives it.
  base: string;
  // Sends a request to the registry and gives back its answer, without following redirects.
  send: (req: Request) => Promise<Response>;
  // The sign-in link the registry last sent to an email address.
  signInLink: (email: string) => Promise<string>;
};

const fixture = (name: string) => readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8");

// A workflow's design without its implementations, as a first version that
// doesn't yet say where it runs.
const designOnly = (workflow: string) => workflow.slice(0, workflow.indexOf("implementations:"));

// A second workflow referring to dinners' favourites, so that part leads to two.
const pantry = fixture("shopping.yaml").replace("title: The family's shopping", "title: The family's pantry");

const recipe = `# Install on a code worker

1. Make a container from the workflow's code.
2. Put the Anthropic key in the worker's secret store as ANTHROPIC_API_KEY.
3. Schedule each trigger with the worker's cron.
4. Check the worker's log after the first run.
`;

const kitchen = `Everything that keeps the family's kitchen going: **dinners** planned each week, and the
**shopping** topped up from the same list.

Ana keeps her own copy of the dinners private.
`;

export async function seed({ base, send, signInLink }: SeedOptions): Promise<{ cookie: string }> {
  async function call(
    method: string,
    path: string,
    body: { json?: unknown; form?: Record<string, string> },
    cookie?: string,
  ) {
    const headers = new Headers({ origin: base });
    if (cookie) headers.set("cookie", cookie);
    let content: string | undefined;
    if (body.json !== undefined) {
      headers.set("content-type", "application/json");
      content = JSON.stringify(body.json);
    } else if (body.form) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      content = new URLSearchParams(body.form).toString();
    }
    const res = await send(new Request(new URL(path, base), { method, headers, body: content, redirect: "manual" }));
    // A form answers with a redirect back to its page, carrying any error in the address.
    const location = res.headers.get("location") ?? "";
    if (res.status >= 400 || location.includes("error=")) {
      throw new Error(`${method} ${path} was refused: ${res.status} ${location} ${await res.text()}`.trim());
    }
    return res;
  }

  async function signIn(email: string) {
    await call("POST", "/api/auth/sign-in/magic-link", { json: { email, callbackURL: "/" } });
    const link = await signInLink(email);
    const verified = await send(new Request(link, { headers: { origin: base }, redirect: "manual" }));
    const cookie = verified.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    if (!cookie) throw new Error(`signing in ${email} gave no session: ${verified.status}`);
    return cookie;
  }

  const ana = await signIn("ana@example.com");
  // Ben signs in once, so that he has an account to be added to acme with.
  await signIn("ben@example.com");
  await call("POST", "/api/orgs", { form: { slug: "acme", name: "Acme" } }, ana);
  await call("POST", "/api/orgs/acme/members", { form: { identifier: "ben", role: "member" } }, ana);

  const pushes: [string, Record<string, string>][] = [
    ["/api/v1/acme/dinners/versions", { workflow: designOnly(fixture("dinners.yaml")), visibility: "public" }],
    ["/api/v1/acme/dinners/versions", { workflow: fixture("dinners.yaml") }],
    ["/api/v1/acme/client-email/versions", { workflow: fixture("client-email.yaml"), visibility: "public" }],
    ["/api/v1/acme/shopping/versions", { workflow: fixture("shopping.yaml"), visibility: "public" }],
    ["/api/v1/acme/pantry/versions", { workflow: pantry, visibility: "public" }],
    ["/api/v1/ana/dinners/versions", { workflow: fixture("dinners.yaml"), visibility: "private" }],
    ["/api/v1/platforms/acme/worker/versions", { description: fixture("platforms/worker.yaml"), visibility: "public" }],
    ["/api/v1/platforms/acme/worker/versions", { description: fixture("platforms/worker.yaml"), recipe }],
    [
      "/api/v1/platforms/acme/codex-laptop/versions",
      { description: fixture("platforms/codex-laptop.yaml"), visibility: "public" },
    ],
    [
      "/api/v1/platforms/acme/cowork-mac-mini/versions",
      { description: fixture("platforms/cowork-mac-mini.yaml"), visibility: "private" },
    ],
  ];
  for (const [path, json] of pushes) await call("POST", path, { json }, ana);
  await call("POST", "/api/v1/acme/dinners/fork", { json: { owner: "ana", slug: "family-dinners", version: 1 } }, ana);
  await call(
    "POST",
    "/api/v1/acme/systems/kitchen/versions",
    {
      json: {
        title: "The family's kitchen",
        description: kitchen,
        members: ["acme/dinners", "acme/shopping", "ana/dinners"],
        visibility: "public",
      },
    },
    ana,
  );

  return { cookie: ana };
}

// The last sign-in link the server's log shows for an email address, waiting up to ten seconds
// for it to be written.
async function linkFromLog(log: string, email: string) {
  for (let waited = 0; waited < 10_000; waited += 200) {
    const links = [...readFileSync(log, "utf8").matchAll(/\[awml\] sign-in link for (\S+): (\S+)/g)];
    const link = links.findLast((m) => m[1] === email);
    if (link) return link[2];
    await sleep(200);
  }
  throw new Error(`the server's log shows no sign-in link for ${email}`);
}

async function main() {
  const { values } = parseArgs({ options: { base: { type: "string" }, log: { type: "string" } } });
  if (!values.base || !values.log) throw new Error("usage: seed-pictures.ts --base <address> --log <server log>");
  const log = values.log;
  const { cookie } = await seed({
    base: values.base,
    send: (req) => fetch(req),
    signInLink: (email) => linkFromLog(log, email),
  });
  console.log(cookie);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
