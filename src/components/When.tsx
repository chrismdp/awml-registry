import { ukTime } from "@/server/page";

// A moment as the registry words it everywhere, in UK time: "Today 4:43pm",
// "Yesterday 9:12am" or "18 Oct 2026, 9:12am".
export function When({ at }: { at: Date }) {
  return <time dateTime={at.toISOString()}>{ukTime(at)}</time>;
}
