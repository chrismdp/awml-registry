// Connected apps, on the Settings page: each AI app a person has allowed to
// use their account through /mcp, and Disconnect, which cuts it off.
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { ukTime } from "@/server/page";
import { listTokens, revokeToken } from "@/server/tokens";
import SettingsPage from "@/app/settings/page";
import { disconnect } from "@/app/settings/actions";
import { person } from "./helpers";
import { call, CIMD_CLIENT, clientMetadata, connect, post, refresh, serveMetadata } from "./mcp-client";
import { pageRequest, renderPage } from "./pages";

afterEach(() => {
  vi.useRealTimers();
});

type Someone = { cookie: string };

const settings = async (who: Someone) => (await renderPage(SettingsPage, {}, { as: who })).html;

// The Connected apps section of someone's settings page.
const connectedApps = async (who: Someone) => (await settings(who)).split("<h2>Connected apps</h2>")[1].split("<h2>")[0];

// Disconnect pressed for an app, as someone or as nobody signed in.
async function pressDisconnect(who: Someone | undefined, clientId: string) {
  pageRequest.headers = new Headers(who ? { cookie: who.cookie } : {});
  const form = new FormData();
  form.set("clientId", clientId);
  await disconnect(form);
}

// The clock moved on: the access token an app holds lasts an hour.
function later(minutes: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + minutes * 60 * 1000);
}

const renews = async (app: { clientId: string; refreshToken: string }) => {
  const res = await refresh(app.clientId, app.refreshToken);
  const body = await res.json();
  return res.status === 200 ? { ...app, accessToken: body.access_token as string, refreshToken: body.refresh_token as string } : null;
};

describe("Connected apps on the settings page", () => {
  it("lists each app the person allowed, when they allowed it and when it last renewed its access", async () => {
    const ana = await person("ana");
    expect(await connectedApps(ana)).toContain("None yet.");
    const allowedAt = new Date();
    const app = await connect(ana);
    serveMetadata({ [CIMD_CLIENT]: clientMetadata(CIMD_CLIENT, "Claude test") });
    await connect(ana, { clientId: CIMD_CLIENT, name: "Claude test" });
    later(90);
    const renewedAt = new Date();
    expect(await renews(app)).not.toBeNull();

    const section = await connectedApps(ana);
    expect(section).toContain("Disconnect one and its access stops within an hour.");
    expect(section).toContain("Test AI");
    expect(section).toContain("Claude test");
    expect(section).toContain(ukTime(allowedAt));
    expect(section).toContain(ukTime(renewedAt));
    expect(section.match(/>Disconnect</g)).toHaveLength(2);
  });
});

describe("Positive boundary", () => {
  it("a person disconnects their own app: it leaves the list, a refresh fails at once and /mcp refuses it once its hour is up", async () => {
    const ana = await person("ana");
    let app = (await renews(await connect(ana)))!;
    expect(await connectedApps(ana)).toContain("Test AI");

    await pressDisconnect(ana, app.clientId);
    expect(await connectedApps(ana)).not.toContain("Test AI");
    const refused = await refresh(app.clientId, app.refreshToken);
    expect([refused.status, (await refused.json()).error]).toEqual([400, "invalid_grant"]);

    // The access token it holds lasts out its hour, as the page says.
    expect((await call("list", {}, app.accessToken)).isError).toBe(false);
    later(61);
    expect((await post("tools/list", {}, app.accessToken)).status).toBe(401);

    // Connecting it again asks the person to allow it again.
    vi.useRealTimers();
    app = await connect(ana, { clientId: app.clientId });
    expect((await call("list", {}, app.accessToken)).isError).toBe(false);
  });
});

describe("Negative boundary", () => {
  it("a person cannot see another person's app, and a Disconnect forged for it changes nothing", async () => {
    const ana = await person("ana");
    const nell = await person("nell");
    const app = await connect(ana);
    expect(await connectedApps(nell)).toContain("None yet.");
    expect(await settings(nell)).not.toContain(app.clientId);

    await pressDisconnect(nell, app.clientId);
    await pressDisconnect(undefined, app.clientId);
    expect(await connectedApps(ana)).toContain("Test AI");
    expect(await renews(app)).not.toBeNull();
  });
});

describe("Cross-tenant boundary", () => {
  it("disconnecting an app for one person leaves another person's access through the same app", async () => {
    serveMetadata();
    const ana = await person("ana");
    const bea = await person("bea");
    const anas = await connect(ana, { clientId: CIMD_CLIENT });
    const beas = await connect(bea, { clientId: CIMD_CLIENT });

    await pressDisconnect(ana, CIMD_CLIENT);
    expect(await connectedApps(ana)).not.toContain("Test AI");
    expect(await connectedApps(bea)).toContain("Test AI");
    expect(await renews(anas)).toBeNull();

    later(61);
    const renewed = (await renews(beas))!;
    expect(renewed).not.toBeNull();
    expect((await call("list", {}, renewed.accessToken)).isError).toBe(false);
  });
});

describe("Registry tokens and connected apps are separate", () => {
  it("disconnecting an app leaves the person's registry token working, and revoking a registry token leaves the app connected", async () => {
    const ana = await person("ana");
    const first = await connect(ana);
    await pressDisconnect(ana, first.clientId);
    expect((await call("list", {}, ana.token)).isError).toBe(false);

    const second = await connect(ana);
    const db = await getDb();
    for (const t of await listTokens(db, ana.id)) await revokeToken(db, ana.id, t.id);
    expect((await post("tools/list", {}, ana.token)).status).toBe(401);
    expect(await connectedApps(ana)).toContain("Test AI");
    expect(await renews(second)).not.toBeNull();
  });
});
