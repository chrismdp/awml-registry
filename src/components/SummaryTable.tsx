import type { Summary } from "@/engine";
import { measures } from "@/server/summary";

export function Labels({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  return (
    <ul className="labels">
      {labels.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );
}

// One version's summary, grouped as `awml summary` groups it.
export function SummaryTable({ summary }: { summary: Summary }) {
  return (
    <table>
      <tbody>
        {measures([summary]).map((m) => (
          <tr key={m.group + m.label}>
            <th scope="row">
              {m.group}: {m.label}
            </th>
            <td>{m.value(summary)}</td>
          </tr>
        ))}
        {summary.publishingLines.labels.length > 0 && (
          <tr>
            <th scope="row">Publishing line labels</th>
            <td>
              <Labels labels={summary.publishingLines.labels} />
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
