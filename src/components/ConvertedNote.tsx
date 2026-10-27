import type { ReactNode } from "react";
import { CURRENT_AWML } from "@/server/awml-file";

// Above a file stored in an older AWML than the registry takes: which AWML it
// is, shown as it was pushed, and what the registry reads converted. Nothing
// for a file of the current AWML, or one that names none.
export function ConvertedNote({ name, awml, children }: { name: string; awml: string | null; children: ReactNode }) {
  if (awml === null || awml === CURRENT_AWML) return null;
  return (
    <p className="converted">
      {name} is AWML {awml}, as it was pushed. {children}
    </p>
  );
}
