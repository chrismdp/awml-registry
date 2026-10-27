// Where a workflow can run: the AWML engine's fit, through POST /api/v1/fit,
// against the platforms in the registry.
import { describe, expect, it } from "vitest";
import { engine } from "@/engine";
import { WORKFLOW_IS_TOO_OLD } from "@/server/awml-file";
import { example, person, request, storeVersion, type Who } from "./helpers";

const clientEmail = example("client-email.yaml");
const dinners = example("dinners.yaml");
const dinnersPlatform = example("legacy/dinners-platform.yaml");

// AWML's example platforms, in the order the native fit was given them.
const ids = ["codex-laptop", "cowork-mac-mini", "scripts-mac-mini", "worker"];
const descriptions = Object.fromEntries(ids.map((id) => [id, example(`platforms/${id}.yaml`)]));

// What `awml fit --json client-email.yaml platforms/*.yaml` printed, by platform.
type FitResult = { platform: string; judged: boolean; fits: boolean; reasons: string[]; models: Record<string, string[]> };
const native = JSON.parse(example("client-email.fit.json")) as { results: FitResult[]; gaps: string[] };
const nativeFor = (id: string) => {
  const { platform: _, ...rest } = native.results.find((r) => r.platform === id)!;
  return rest;
};

const fit = async (body: unknown, as?: Who) => {
  const res = await request("POST", "/api/v1/fit", { as, json: body });
  return { status: res.status, body: await res.json() };
};

// Ana, who has pushed AWML's four example platforms as public ones of her
// own, under their ids, and the client email workflow.
async function ana() {
  const ana = await person("ana");
  for (const id of ids) {
    const res = await request("POST", `/api/v1/platforms/${ana.username}/${id}/versions`, {
      as: { token: ana.token },
      json: { description: descriptions[id] },
    });
    expect(res.status).toBe(201);
  }
  const pushed = await request("POST", `/api/v1/${ana.username}/client-email/versions`, {
    as: { token: ana.token },
    json: { workflow: clientEmail },
  });
  expect(pushed.status).toBe(201);
  return ana;
}

describe("the engine's fit", () => {
  it("gives what the native `awml fit --json` gives", async () => {
    expect(await engine.fit(clientEmail, ids.map((id) => descriptions[id]))).toEqual(native);
    expect(await engine.fit(dinners, [descriptions.worker])).toEqual(JSON.parse(example("dinners.fit.json")));
  });
});

describe("fitting a workflow through the API", () => {
  it("fits a stored workflow against the platforms named, giving each the native fit's answer under its address", async () => {
    const { username } = await ana();
    const res = await fit({ workflow: `${username}/client-email`, platforms: [`${username}/worker`, `${username}/scripts-mac-mini`] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      workflow: { owner: username, slug: "client-email", number: 1 },
      implementation: null,
      results: [
        { platform: `${username}/worker`, number: 1, id: "worker", label: "A code worker", ...nativeFor("worker") },
        {
          platform: `${username}/scripts-mac-mini`,
          number: 1,
          id: "scripts-mac-mini",
          label: "Scheduled scripts on a Mac mini",
          ...nativeFor("scripts-mac-mini"),
        },
      ],
      gaps: [],
    });
  });

  it("fits the YAML of a workflow's file sent with the request", async () => {
    const { username } = await ana();
    const res = await fit({ file: clientEmail, platforms: [`${username}/codex-laptop`] });
    expect(res.status).toBe(200);
    expect(res.body.workflow).toBeNull();
    expect(res.body.results).toEqual([
      { platform: `${username}/codex-laptop`, number: 1, id: "codex-laptop", label: "Codex on a laptop", ...nativeFor("codex-laptop") },
    ]);
  });

  it("fits against every platform the caller can see when none are named", async () => {
    const { username, token } = await ana();
    for (const as of [undefined, { token }]) {
      const res = await fit({ workflow: `${username}/client-email` }, as);
      expect(res.status).toBe(200);
      const byPlatform = Object.fromEntries(res.body.results.map((r: FitResult) => [r.platform, r]));
      expect(Object.keys(byPlatform).sort()).toEqual(ids.map((id) => `${username}/${id}`));
      for (const id of ids) expect(byPlatform[`${username}/${id}`]).toMatchObject(nativeFor(id));
    }
  });

  it("fits a given version of the workflow and of each platform", async () => {
    const { username, token } = await ana();
    const patient = clientEmail.replace("wait: PT2H", "wait: P30D");
    await request("POST", `/api/v1/${username}/client-email/versions`, { as: { token }, json: { workflow: patient } });
    await request("POST", `/api/v1/platforms/${username}/codex-laptop/versions`, {
      as: { token },
      json: { description: descriptions.worker },
    });
    const old = await fit({ workflow: `${username}/client-email@1`, platforms: [`${username}/codex-laptop@1`] });
    expect(old.body.workflow).toEqual({ owner: username, slug: "client-email", number: 1 });
    expect(old.body.results[0]).toMatchObject({ number: 1, id: "codex-laptop", reasons: nativeFor("codex-laptop").reasons });
    const latest = await fit({ workflow: `${username}/client-email`, platforms: [`${username}/codex-laptop@1`] });
    expect(latest.body.workflow.number).toBe(2);
    expect(latest.body.results[0].reasons).toEqual(["openai's agents run here, and business doesn't allow openai"]);
    const newest = await fit({ workflow: `${username}/client-email`, platforms: [`${username}/codex-laptop`] });
    expect(newest.body.results[0]).toMatchObject({ number: 2, id: "worker" });
  });

  it("gives the gaps, and no results, when the workflow doesn't say what it needs", async () => {
    const { username } = await ana();
    const res = await fit({ file: dinners, platforms: [`${username}/worker`] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ workflow: null, implementation: null, ...JSON.parse(example("dinners.fit.json")) });
  });

  it("gives no results when there are no platforms to fit against", async () => {
    const nell = await person("nell");
    expect(await fit({ file: clientEmail }, { token: nell.token })).toEqual({
      status: 200,
      body: { workflow: null, implementation: null, results: [], gaps: [] },
    });
  });

  it("refuses a request it cannot fit, saying why", async () => {
    const a = await ana();
    const { username } = a;
    // A version stored before the registry took only 0.4 files, with only a platform view.
    await storeVersion(username, "drawn", a, { platform: dinnersPlatform }, { summary: JSON.parse(example("legacy/dinners-platform.summary.json")) });
    const cases: [unknown, number, string[]][] = [
      [{}, 422, ["Send a workflow as owner/slug, or its AWML 0.7 file as file."]],
      [{ workflow: `${username}/client-email`, file: clientEmail }, 422, ["Send a workflow or the YAML of its file, not both."]],
      [{ workflow: "client-email" }, 422, ["Name the workflow as owner/slug or owner/slug@version."]],
      [{ workflow: `${username}/nothing-here` }, 404, [`Not found: ${username}/nothing-here.`]],
      [{ workflow: `${username}/client-email@9` }, 404, [`Not found: ${username}/client-email@9.`]],
      [{ workflow: `${username}/drawn` }, 422, [`${username}/drawn v1 has no security view, which the fit needs.`]],
      [{ file: dinnersPlatform }, 400, [WORKFLOW_IS_TOO_OLD]],
      [{ file: descriptions.worker }, 422, ["file: this is a platform description; the fit needs a workflow."]],
      [{ file: "title: nonsense\n" }, 422, (await engine.check("title: nonsense\n")).map((e) => `file: ${e}`)],
      [{ file: clientEmail, implementation: 7 }, 422, ["implementation is the id of one of the workflow's implementations."]],
      [{ file: clientEmail, implementation: "home" }, 422, ['This workflow has no implementation "home".']],
      [{ file: clientEmail, platforms: "all" }, 422, ["platforms is a list of owner/slug or owner/slug@version."]],
      [{ file: clientEmail, platforms: [`${username}/nothing-here`] }, 404, [`Not found: ${username}/nothing-here.`]],
    ];
    for (const [body, status, errors] of cases) {
      const res = await fit(body);
      expect(res, JSON.stringify(body)).toEqual({ status, body: { errors } });
    }
  });
});
