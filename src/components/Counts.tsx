export function Counts({ counts }: { counts: Record<string, number> }) {
  const keys = Object.keys(counts).sort();
  if (keys.length === 0) return <p>No counts.</p>;
  return (
    <table>
      <tbody>
        {keys.map((k) => (
          <tr key={k}>
            <th scope="row">{k}</th>
            <td>{counts[k]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
