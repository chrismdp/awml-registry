import type { Summary } from "@/engine";

// One column of an inventory, or one row of a version's summary.
export type Measure = { group: string; label: string; value: (s: Summary) => number };

// The measures for a set of summaries, in a fixed order. Operations are those
// any of the summaries uses.
export function measures(summaries: Summary[]): Measure[] {
  const operations = [...new Set(summaries.flatMap((s) => Object.keys(s.operations ?? {})))].sort();
  return [
    { group: "Steps", label: "AI", value: (s) => s.steps.ai },
    { group: "Steps", label: "Code", value: (s) => s.steps.code },
    { group: "Steps", label: "Person", value: (s) => s.steps.person },
    ...operations.map((op) => ({ group: "Operations", label: op, value: (s: Summary) => s.operations?.[op] ?? 0 })),
    { group: "Outside actions", label: "Allow", value: (s) => s.outsideActions.allow },
    { group: "Outside actions", label: "Ask", value: (s) => s.outsideActions.ask },
    { group: "Outside actions", label: "Block", value: (s) => s.outsideActions.block },
    { group: "Parts", label: "Triggers", value: (s) => s.triggers },
    { group: "Parts", label: "Reviews", value: (s) => s.reviews },
    { group: "Parts", label: "Contexts", value: (s) => s.contexts },
    { group: "Parts", label: "Connectors", value: (s) => s.connectors },
    { group: "Parts", label: "Surfaces", value: (s) => s.surfaces },
    { group: "Groups", label: "Scopes", value: (s) => s.scopes },
    { group: "Groups", label: "Platforms", value: (s) => s.platforms },
    { group: "Lines", label: "Publishing lines", value: (s) => s.publishingLines.count },
    { group: "Lines", label: "Refused reads", value: (s) => s.refusedReads },
    { group: "Lines", label: "Red lines", value: (s) => s.redLines },
  ];
}

// Every count added up; publishing line labels listed once each, not added.
export function total(summaries: Summary[]): Summary {
  const sum = (f: (s: Summary) => number) => summaries.reduce((n, s) => n + f(s), 0);
  const operations: Record<string, number> = {};
  for (const s of summaries)
    for (const [op, n] of Object.entries(s.operations ?? {})) operations[op] = (operations[op] ?? 0) + n;
  return {
    steps: { ai: sum((s) => s.steps.ai), code: sum((s) => s.steps.code), person: sum((s) => s.steps.person) },
    operations,
    outsideActions: {
      allow: sum((s) => s.outsideActions.allow),
      ask: sum((s) => s.outsideActions.ask),
      block: sum((s) => s.outsideActions.block),
    },
    triggers: sum((s) => s.triggers),
    reviews: sum((s) => s.reviews),
    contexts: sum((s) => s.contexts),
    connectors: sum((s) => s.connectors),
    surfaces: sum((s) => s.surfaces),
    scopes: sum((s) => s.scopes),
    platforms: sum((s) => s.platforms),
    publishingLines: {
      count: sum((s) => s.publishingLines.count),
      labels: [...new Set(summaries.flatMap((s) => s.publishingLines.labels ?? []))],
    },
    refusedReads: sum((s) => s.refusedReads),
    redLines: sum((s) => s.redLines),
  };
}

// The names in a summary, each an empty list when there are none.
export function names(s: Summary) {
  return {
    aiSteps: s.aiSteps ?? [],
    people: s.people ?? [],
    scopeNames: s.scopeNames ?? [],
    platformNames: s.platformNames ?? [],
    publishingLabels: s.publishingLines.labels ?? [],
  };
}

// How many steps there are, whoever decides them.
export const stepCount = (s: Summary) => s.steps.ai + s.steps.code + s.steps.person;

// Whether a person decides anything: a person step or a review.
export const hasPerson = (s: Summary) => s.steps.person + s.reviews > 0;
