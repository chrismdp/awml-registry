// "1 line", "2 lines".
export const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// "a", "a and b", "a, b and c".
export const naturalList = (items: string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0];

// The AI steps that may use the same companies, as `awml fit` says it:
// "choose, draft and learn may use anthropic".
export function mayUse(models: Record<string, string[]>) {
  const byCompanies = new Map<string, string[]>();
  for (const [step, companies] of Object.entries(models)) {
    const key = companies.join(" and ");
    byCompanies.set(key, [...(byCompanies.get(key) ?? []), step]);
  }
  return [...byCompanies].map(([companies, steps]) => `${naturalList(steps)} may use ${companies}`).join("; ");
}
