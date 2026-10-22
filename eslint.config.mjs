import tseslint from "typescript-eslint";
import awml from "./eslint-rules/index.mjs";

export default [
  { ignores: [".next/", ".open-next/", ".wrangler/", "node_modules/", "vendor/", "data/", "next-env.d.ts"] },
  {
    files: ["**/*.{ts,tsx,mjs}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { awml },
  },
  {
    files: ["src/**/*.{ts,tsx}", "test/**/*.{ts,tsx}"],
    rules: { "awml/no-billing": "error" },
  },
  {
    // The MCP server's tools read through the same checked functions as the
    // routes, so the rule keeps the schema and drizzle out of it too.
    files: ["src/app/**/*.{ts,tsx}", "src/server/mcp.ts"],
    rules: { "awml/access-checked": "error" },
  },
];
