import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { flowOnly, parseMermaid, triggersOutside, type Graph } from "@/components/flow/graph";

// The Mermaid text AWML 0.6.0's engine draws, as the registry gets it: the
// security view of chrismdp/issue-to-pull-request (version 20 on awml.io),
// the map of the factory system it is in, and the dinners example's security
// view, whose scopes nest three deep.
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const issue = parseMermaid(fixture("flow/issue-to-pull-request.mmd"));
const map = parseMermaid(fixture("flow/factory-map.mmd"));
const dinners = parseMermaid(fixture("dinners.mmd"));

const part = (g: Graph, id: string) => g.parts.find((p) => p.id === id);
const line = (g: Graph, from: string, to: string) => g.lines.find((l) => l.from === from && l.to === to);

describe("reading a drawing's graph from the engine's Mermaid text", () => {
  it("reads every part with its kind and its label as plain text", () => {
    expect(issue.parts).toHaveLength(23);
    expect(part(issue, "comment")).toEqual({ id: "comment", kind: "trigger", label: "The build label is added to an issue", scope: "public" });
    expect(part(issue, "repo")).toMatchObject({
      kind: "context",
      label: "The spec, guide, code, AGENTS.md and REVIEW.md, which says what failure looks like here",
    });
    expect(part(issue, "token")).toMatchObject({ kind: "connection", label: "The repository, through its own Actions token" });
    expect(part(dinners, "screen")).toMatchObject({ kind: "surface", label: "Kitchen screen" });
  });

  it("reads a step's decider and verb from its caption, and an outside action's tier", () => {
    expect(part(issue, "build")).toMatchObject({
      kind: "ai",
      verb: "draft",
      label: "Write the change test first, then redraw the examples it alters and picture, before and after, those that look different",
    });
    expect(part(issue, "who")).toMatchObject({ kind: "code", verb: "sort", label: "Sort by rule: is the label build?" });
    expect(part(dinners, "approve")).toMatchObject({ kind: "person", verb: "review", label: "Owen's yes to the exact basket" });
    // A step whose kind of work isn't given has no verb.
    expect(part(dinners, "plan")).toEqual({ id: "plan", kind: "ai", label: "Plan next week's dinners", scope: "family" });
    expect(part(issue, "status")).toMatchObject({ kind: "outside", label: "Post or edit the build's status comment", tier: "Allow" });
    expect(part(dinners, "basket")).toMatchObject({ label: "Fill the basket", tier: "Allow under £180" });
  });

  it("reads scopes with their nesting, and which part is in which", () => {
    expect(issue.scopes).toEqual([{ id: "public", label: "public: anyone who reads the repository", dashed: true }]);
    expect(dinners.scopes).toEqual([
      { id: "carers", label: "carers: + June, Beth", dashed: true },
      { id: "family", label: "family: parents, kids", dashed: true, scope: "carers" },
      { id: "household", label: "household: parents", dashed: true, scope: "family" },
    ]);
    expect(part(dinners, "calendar")?.scope).toBe("carers");
    expect(part(dinners, "favourites")?.scope).toBe("family");
    expect(part(dinners, "bank")?.scope).toBe("household");
  });

  it("reads solid, dotted and thick lines, their labels, and which ends have arrows", () => {
    expect(issue.lines).toHaveLength(37);
    expect(line(issue, "comment", "who")).toMatchObject({ style: "solid", label: "the label", arrowStart: false, arrowEnd: true });
    expect(line(issue, "who", "started")).toMatchObject({ label: "[build]" });
    expect(line(issue, "repo", "build")).toMatchObject({ style: "dotted", arrowStart: false, arrowEnd: true });
    expect(line(issue, "repo", "build")?.label).toBeUndefined();
    expect(line(issue, "started", "status")).toMatchObject({ style: "solid", arrowStart: false, arrowEnd: true });
    // Two-way lines whose end arrow the engine takes off with linkStyle.
    expect(line(issue, "build", "findings")).toMatchObject({ style: "dotted", label: "what the reviews found", arrowStart: true, arrowEnd: false });
    expect(line(issue, "token", "status")).toMatchObject({ style: "dotted", arrowStart: true, arrowEnd: false });
    expect(line(issue, "weigh", "findings")).toMatchObject({ style: "dotted", arrowStart: false, arrowEnd: true });
    expect(line(dinners, "screen", "mealplan")).toMatchObject({
      style: "thick",
      label: "standing rule: dinners to carers · adds June and Beth",
      arrowStart: true,
      arrowEnd: false,
    });
  });

  it("takes notes out of the drawing, each with the part it belongs to", () => {
    expect(issue.notes).toHaveLength(8);
    expect(issue.notes.find((n) => n.id === "strangers")).toEqual({
      id: "strangers",
      on: "bring",
      text: "Anyone can comment, but the bring-in step passes on only the comments of the owner, members and collaborators, so strangers' text never reaches the draft step. AWML can't mark this yet (awml #5)",
    });
    // A note drawn outside every scope belongs to its part all the same.
    expect(issue.notes.find((n) => n.id === "label")?.on).toBe("comment");
    expect(dinners.notes).toEqual([
      { id: "screen_gap", on: "screen", text: "Missing from the design: no scheduled task keeps the screen current" },
    ]);
    // No note is a part, and no line leads to one.
    const notes = new Set(issue.notes.map((n) => n.id));
    expect(issue.parts.filter((p) => notes.has(p.id))).toEqual([]);
    expect(issue.lines.filter((l) => notes.has(l.from) || notes.has(l.to))).toEqual([]);
  });

  it("reads a system's map: a box per workflow, and lines to and from the boxes", () => {
    expect(map.scopes.map((s) => [s.id, s.label, s.dashed])).toEqual([
      ["w1", "An issue becomes a pull request", false],
      ["w2", "A pull request lands once CI has run", false],
      ["w3", "A failed build tries again", false],
    ]);
    expect(part(map, "w1_comment")).toMatchObject({ kind: "trigger", scope: "w1" });
    expect(line(map, "s1", "w1")).toMatchObject({ style: "solid" });
    expect(line(map, "w3", "s1")).toMatchObject({ style: "solid" });
    expect(map.lines).toHaveLength(20);
  });
});

describe("Flow only", () => {
  it("leaves out contexts and every dotted line, and the parts no line is left to", () => {
    const flow = flowOnly(issue);
    expect(flow.lines.every((l) => l.style !== "dotted")).toBe(true);
    expect(flow.parts.filter((p) => p.kind === "context")).toEqual([]);
    // Connections are reached only by dotted lines, so none is left.
    expect(flow.parts.filter((p) => p.kind === "connection")).toEqual([]);
    // Every step stays, and every trigger and outside action with a line.
    expect(flow.parts.filter((p) => ["ai", "code", "person"].includes(p.kind))).toHaveLength(10);
    expect(part(flow, "pr")).toBeDefined();
    expect(part(flow, "comment")).toBeDefined();
    expect(flow.lines).toHaveLength(issue.lines.filter((l) => l.style !== "dotted").length);
  });

  it("keeps the notes of the parts it keeps", () => {
    // The GitHub App's note goes with it; the kitchen screen's goes with the screen.
    expect(flowOnly(issue).notes.map((n) => n.on).sort()).toEqual(["bring", "build", "comment", "gate", "open", "review", "started"]);
    expect(flowOnly(dinners).notes).toEqual([]);
  });

  it("drops a thick line when a part it joins goes, and keeps every scope", () => {
    // The standing rule joins a surface and a context, so both go, and it with them.
    expect(flowOnly(dinners).lines.find((l) => l.style === "thick")).toBeUndefined();
    expect(flowOnly(dinners).scopes).toEqual(dinners.scopes);
  });
});

describe("a map's triggers, outside their workflow's box", () => {
  it("moves each trigger out of its box, with a line into it", () => {
    const moved = triggersOutside(map);
    expect(part(moved, "w1_comment")?.scope).toBeUndefined();
    expect(line(moved, "w1_comment", "w1")).toMatchObject({ style: "solid", arrowEnd: true });
    expect(moved.lines).toHaveLength(map.lines.length + 1);
  });

  it("leaves a drawing with no workflow boxes as it is", () => {
    expect(triggersOutside(issue)).toEqual(issue);
  });
});
