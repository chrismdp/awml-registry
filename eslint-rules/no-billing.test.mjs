import rule from "./no-billing.mjs";
import { tester } from "./tester.mjs";

tester.run("no-billing", rule, {
  valid: [
    { name: "ordinary code", code: `export async function canPush(org) { return true; }` },
    { name: "the edition hook as it stands", filename: "/repo/src/edition.ts", code: `// The hosted service replaces this file.\nexport const edition = { async canKeepPrivate() { return true; } };` },
    { name: "a word that merely contains check", code: `const checked = await engine.check(yaml); // Check out the result` },
  ],
  invalid: [
    {
      name: "an import",
      code: `import Stripe from "stripe";`,
      errors: [{ messageId: "billing", data: { word: "Stripe" } }, { messageId: "billing", data: { word: "stripe" } }],
    },
    { name: "an identifier", code: `const subscriptionEnds = 1;`, errors: [{ messageId: "billing", data: { word: "subscription" } }] },
    { name: "a string", code: `const path = "/settings/billing";`, errors: [{ messageId: "billing", data: { word: "billing" } }] },
    { name: "a comment", code: `// TODO: send the invoice\nconst x = 1;`, errors: [{ messageId: "billing", data: { word: "invoice" } }] },
    { name: "JSX text", code: `const a = <a href="/x">Go to Checkout</a>;`, errors: [{ messageId: "billing", data: { word: "Checkout" } }] },
    {
      name: "the edition hook itself",
      filename: "/repo/src/edition.ts",
      code: `// canPush says no after a lapsed subscription\nexport const edition = {};`,
      errors: [{ messageId: "billing", data: { word: "subscription" } }],
    },
  ],
});
