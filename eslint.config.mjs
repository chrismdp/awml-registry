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
    files: ["src/app/**/*.{ts,tsx}"],
    rules: { "awml/access-checked": "error" },
  },
];
