import { describe, expect, it } from "vitest";
import { example, person, request } from "./helpers";

const workflow = example("dinners.yaml");

describe("pushing a workflow through the API", () => {
  it("makes the workflow on the first push and returns 201 with where it lives", async () => {
    const ana = await person("ana");
    const res = await request("POST", `/api/v1/${ana.username}/dinners/versions`, {
      as: { token: ana.token },
      json: { workflow },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      owner: ana.username,
      slug: "dinners",
      number: 1,
      url: `http://localhost:3000/${ana.username}/dinners/v/1`,
    });
  });

  it("numbers each push as a new version", async () => {
    const ana = await person("ana");
    const push = () =>
      request("POST", `/api/v1/${ana.username}/dinners/versions`, {
        as: { token: ana.token },
        json: { workflow },
      });
    await push();
    const second = await push();
    expect((await second.json()).number).toBe(2);
  });

  it("refuses a file with mistakes with 422 and the messages", async () => {
    const ana = await person("ana");
    const res = await request("POST", `/api/v1/${ana.username}/dinners/versions`, {
      as: { token: ana.token },
      json: { workflow: "this: is not a workflow\n" },
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it("refuses an invalid file with 422 and the messages `awml check` prints for it", async () => {
    const ana = await person("ana");
    const printed = example("bad-06.check.txt").trim().split("\n");
    expect(printed.length).toBeGreaterThan(0);
    const res = await request("POST", `/api/v1/${ana.username}/broken/versions`, {
      as: { token: ana.token },
      json: { workflow: example("bad-06.yaml") },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).errors).toEqual(printed.map((line) => line.replace(/^bad-06\.yaml: /, "workflow: ")));
  });

  it("stores the summary `awml summary --json` gives", async () => {
    const ana = await person("ana");
    const res = await request("POST", `/api/v1/${ana.username}/dinners/versions`, {
      as: { token: ana.token },
      json: { workflow },
    });
    expect(res.status).toBe(201);
    const stored = await (await request("GET", `/api/v1/${ana.username}/dinners/v/1`)).json();
    expect(stored.summary).toEqual(JSON.parse(example("dinners.summary.json")));
  });

  it("refuses a push with no files", async () => {
    const ana = await person("ana");
    const res = await request("POST", `/api/v1/${ana.username}/dinners/versions`, {
      as: { token: ana.token },
      json: {},
    });
    expect(res.status).toBe(422);
  });

  it("refuses a push from nobody with 401", async () => {
    const ana = await person("ana");
    const res = await request("POST", `/api/v1/${ana.username}/dinners/versions`, {
      json: { workflow },
    });
    expect(res.status).toBe(401);
  });

  it("lets nobody push to someone else's own workflows", async () => {
    const ana = await person("ana");
    const ben = await person("ben");
    const res = await request("POST", `/api/v1/${ana.username}/dinners/versions`, {
      as: { token: ben.token },
      json: { workflow },
    });
    expect(res.status).toBe(403);
  });

  it("lets a user keep a private workflow on their own account", async () => {
    const ana = await person("ana");
    const res = await request("POST", `/api/v1/${ana.username}/dinners/versions`, {
      as: { token: ana.token },
      json: { workflow, visibility: "private" },
    });
    expect(res.status).toBe(201);
    const read = await request("GET", `/api/v1/${ana.username}/dinners`, { as: { token: ana.token } });
    expect((await read.json()).visibility).toBe("private");
    expect((await request("GET", `/api/v1/${ana.username}/dinners`)).status).toBe(404);
  });

  it("answers 404 for an owner that does not exist", async () => {
    const ana = await person("ana");
    const res = await request("POST", `/api/v1/nobody-here/dinners/versions`, {
      as: { token: ana.token },
      json: { workflow },
    });
    expect(res.status).toBe(404);
  });

  it("refuses a workflow slug that is not a slug", async () => {
    const ana = await person("ana");
    const res = await request("POST", `/api/v1/${ana.username}/Not%20A%20Slug/versions`, {
      as: { token: ana.token },
      json: { workflow },
    });
    expect(res.status).toBe(422);
  });

  it("accepts a browser session as well as a token", async () => {
    const ana = await person("ana");
    const res = await request("POST", `/api/v1/${ana.username}/dinners/versions`, {
      as: { cookie: ana.cookie },
      json: { workflow },
    });
    expect(res.status).toBe(201);
  });
});

describe("reading a workflow through the API", () => {
  it("gives the workflow and its versions to anyone when it is public", async () => {
    const ana = await person("ana");
    for (let i = 0; i < 2; i++) {
      await request("POST", `/api/v1/${ana.username}/dinners/versions`, {
        as: { token: ana.token },
        json: { workflow },
      });
    }
    const res = await request("GET", `/api/v1/${ana.username}/dinners`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      owner: ana.username,
      slug: "dinners",
      title: "The family's dinners",
      visibility: "public",
    });
    expect(body.versions.map((v: { number: number }) => v.number)).toEqual([2, 1]);
    expect(body.versions[0]).toMatchObject({ pushedBy: ana.username });
  });

  it("gives one version's files, check result and summary", async () => {
    const ana = await person("ana");
    await request("POST", `/api/v1/${ana.username}/dinners/versions`, {
      as: { token: ana.token },
      json: { workflow },
    });
    const res = await request("GET", `/api/v1/${ana.username}/dinners/v/1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.number).toBe(1);
    expect(body.files).toEqual({ workflow });
    expect(body.check).toEqual({ workflow: [] });
    expect(body.summary).toEqual(JSON.parse(example("dinners.summary.json")));
  });

  it("answers 404 for a version that does not exist", async () => {
    const ana = await person("ana");
    await request("POST", `/api/v1/${ana.username}/dinners/versions`, {
      as: { token: ana.token },
      json: { workflow },
    });
    expect((await request("GET", `/api/v1/${ana.username}/dinners/v/9`)).status).toBe(404);
    expect((await request("GET", `/api/v1/${ana.username}/dinners/v/x`)).status).toBe(404);
    expect((await request("GET", `/api/v1/${ana.username}/other`)).status).toBe(404);
  });

  it("downloads one file of a version as YAML", async () => {
    const ana = await person("ana");
    await request("POST", `/api/v1/${ana.username}/dinners/versions`, {
      as: { token: ana.token },
      json: { workflow },
    });
    const res = await request("GET", `/${ana.username}/dinners/v/1/workflow.yaml`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/yaml/);
    expect(await res.text()).toBe(workflow);
    expect((await request("GET", `/${ana.username}/dinners/v/1/security.yaml`)).status).toBe(404);
    expect((await request("GET", `/${ana.username}/dinners/v/1/other.yaml`)).status).toBe(404);
  });
});
