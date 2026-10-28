// Run before test/setup.ts, which loads the engine: the AWML engine is built from the commit
// vendor/awml/version.json pins, and never kept in git (issue #73), so a clone without it says how
// to build it, rather than failing on a missing module in every test file.
import fs from "node:fs";
import path from "node:path";

for (const file of ["awml.wasm", "wasm_exec.js"])
  if (!fs.existsSync(path.join("vendor", "awml", file)))
    throw new Error(`The AWML engine isn't built: vendor/awml/${file} is missing. Run: npm run engine:build`);
