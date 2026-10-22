// Platforms through the API: pushing a platform's description, with an
// install recipe or without, and reading it back.
import { describe, expect, it } from "vitest";
import { signIn, example, person, request, type Who } from "./helpers";

const worker = example("platforms/worker.yaml");
const laptop = example("platforms/codex-laptop.yaml");
const dinners = example("dinners.yaml");

const recipe = `# Install on a code worker

1. Make a container from the workflow's code.
2. Put the Anthropic key in the worker's secret store as ANTHROPIC_API_KEY.
3. Schedule each trigger with the worker's cron.
4. Check the worker's log after the first run.
`;

function pushPlatform(owner: string, slug: string, as: Who, body: Record<string, unknown>) {
  return request("POST", `/api/v1/platforms/${owner}/${slug}/versions`, { as, json: body });
}

describe("pushing a platform through the API", () => {
  it("makes the platform on the first push and returns 201 with its version's page", async () => {
    const ana = await person("ana");
    const res = await pushPlatform(ana.username, "worker", { token: ana.token }, { description: worker, recipe });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      owner: ana.username,
      slug: "worker",
      number: 1,
      url: `http://localhost:3000/${ana.username}/platforms/worker/v/1`,
    });
  });

  it("numbers each push as a new version, which never changes", async () => {
    const ana = await person("ana");
    await pushPlatform(ana.username, "box", { token: ana.token }, { description: worker, recipe });
    const second = await pushPlatform(ana.username, "box", { token: ana.token }, { description: laptop });
    expect((await second.json()).number).toBe(2);
    const first = await (await request("GET", `/api/v1/platforms/${ana.username}/box/v/1`)).json();
    expect(first).toMatchObject({ number: 1, description: worker, recipe, label: "A code worker" });
  });

  it("refuses a description with mistakes with 422 and the messages `awml check` gives", async () => {
    const ana = await person("ana");
    const res = await pushPlatform(ana.username, "box", { token: ana.token }, {
      description: worker.replace("steps: code", "steps: maybe"),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).errors).toEqual(['description: steps must be "code" or "agent", not "maybe"']);
    expect((await request("GET", `/api/v1/platforms/${ana.username}/box`)).status).toBe(404);
  });

  it("refuses a workflow sent as a platform description", async () => {
    const ana = await person("ana");
    const res = await pushPlatform(ana.username, "box", { token: ana.token }, { description: dinners });
    expect(res.status).toBe(422);
    expect((await res.json()).errors).toEqual([
      "description: this is a workflow, not a platform description. Push it as a workflow.",
    ]);
  });

  it("refuses a platform description sent as a workflow's file", async () => {
    const ana = await person("ana");
    const res = await request("POST", `/api/v1/${ana.username}/box/versions`, {
      as: { token: ana.token },
      json: { workflow: worker },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).errors).toEqual([
      "workflow: this is a platform description, not a workflow. Push it as a platform.",
    ]);
  });

  it("refuses a push with no description, or a recipe that is not text", async () => {
    const ana = await person("ana");
    const as = { token: ana.token };
    const none = await pushPlatform(ana.username, "box", as, { recipe });
    expect([none.status, (await none.json()).errors]).toEqual([422, ["Send the platform's description as YAML."]]);
    const notText = await pushPlatform(ana.username, "box", as, { description: worker, recipe: ["step"] });
    expect([notText.status, (await notText.json()).errors]).toEqual([422, ["Send the recipe as Markdown text."]]);
  });

  it("refuses a push from nobody with 401, and to someone else's platforms with 403", async () => {
    const ana = await person("ana");
    const ben = await person("ben");
    expect((await pushPlatform(ana.username, "box", undefined, { description: worker })).status).toBe(401);
    expect((await pushPlatform(ana.username, "box", { token: ben.token }, { description: worker })).status).toBe(403);
  });

  it("keeps a user's own platforms public, as their workflows are", async () => {
    const ana = await person("ana");
    const res = await pushPlatform(ana.username, "box", { token: ana.token }, { description: worker, visibility: "private" });
    expect(res.status).toBe(422);
    expect((await res.json()).errors).toEqual(["Private platforms belong to organisations. Push it to one of yours."]);
  });

  it("refuses a slug that is not a slug, and answers 404 for an owner that does not exist", async () => {
    const ana = await person("ana");
    const as = { token: ana.token };
    expect((await pushPlatform(ana.username, "Not%20A%20Slug", as, { description: worker })).status).toBe(422);
    expect((await pushPlatform("nobody-here", "box", as, { description: worker })).status).toBe(404);
  });

  it("accepts a browser session as well as a token", async () => {
    const ana = await person("ana");
    expect((await pushPlatform(ana.username, "box", { cookie: ana.cookie }, { description: worker })).status).toBe(201);
  });

  it("keeps platforms apart from workflows, so one owner may have both under one slug", async () => {
    const ana = await person("ana");
    expect((await pushPlatform(ana.username, "dinners", { token: ana.token }, { description: worker })).status).toBe(201);
    const workflow = await request("POST", `/api/v1/${ana.username}/dinners/versions`, {
      as: { token: ana.token },
      json: { workflow: dinners },
    });
    expect((await workflow.json()).number).toBe(1);
  });
});

describe("reading a platform through the API", () => {
  it("gives the latest version, its recipe and the list of versions to anyone when it is public", async () => {
    const ana = await person("ana");
    await pushPlatform(ana.username, "box", { token: ana.token }, { description: laptop });
    await pushPlatform(ana.username, "box", { token: ana.token }, { description: worker, recipe });
    const res = await request("GET", `/api/v1/platforms/${ana.username}/box`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      owner: ana.username,
      slug: "box",
      label: "A code worker",
      visibility: "public",
      number: 2,
      pushedBy: ana.username,
      description: worker,
      recipe,
    });
    expect(body.versions.map((v: { number: number }) => v.number)).toEqual([2, 1]);
    const first = await (await request("GET", `/api/v1/platforms/${ana.username}/box/v/1`)).json();
    expect(first).toMatchObject({ number: 1, label: "Codex on a laptop", description: laptop, recipe: null });
    expect(first.versions).toBeUndefined();
  });

  it("answers 404 for a platform or a version that does not exist", async () => {
    const ana = await person("ana");
    await pushPlatform(ana.username, "box", { token: ana.token }, { description: worker });
    for (const path of [
      `/api/v1/platforms/${ana.username}/other`,
      `/api/v1/platforms/${ana.username}/box/v/9`,
      `/api/v1/platforms/${ana.username}/box/v/x`,
      `/api/v1/platforms/nobody-here/box`,
    ])
      expect((await request("GET", path)).status, path).toBe(404);
  });

  it("downloads a version's description as YAML and its recipe as Markdown", async () => {
    const ana = await person("ana");
    await pushPlatform(ana.username, "box", { token: ana.token }, { description: worker, recipe });
    await pushPlatform(ana.username, "box", { token: ana.token }, { description: worker });
    const yaml = await request("GET", `/${ana.username}/platforms/box/v/1/description.yaml`);
    expect([yaml.status, yaml.headers.get("content-type"), await yaml.text()]).toEqual([
      200,
      "application/yaml; charset=utf-8",
      worker,
    ]);
    const md = await request("GET", `/${ana.username}/platforms/box/v/1/recipe.md`);
    expect([md.status, md.headers.get("content-type"), await md.text()]).toEqual([
      200,
      "text/markdown; charset=utf-8",
      recipe,
    ]);
    expect((await request("GET", `/${ana.username}/platforms/box/v/2/recipe.md`)).status).toBe(404);
    expect((await request("GET", `/${ana.username}/platforms/box/v/1/other.yaml`)).status).toBe(404);
  });
});

describe("the platforms namespace", () => {
  it("is reserved, so no user or organisation can be called platforms", async () => {
    expect((await signIn("platforms@example.com")).user.username).toBe("platforms-2");
    const ana = await person("ana");
    const res = await request("POST", "/api/orgs", { as: { cookie: ana.cookie }, form: { slug: "platforms", name: "x" } });
    expect(res.headers.get("location")).toContain("error=");
  });
});
