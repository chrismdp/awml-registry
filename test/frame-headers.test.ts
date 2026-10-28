// Which pages another site may frame (#75): only the embed pages, which send
// `Content-Security-Policy: frame-ancestors *` and no X-Frame-Options. Every other address sends
// `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`, so sign-in and settings can't be
// clickjacked. The headers are next.config.ts's, matched here both ways they are matched in
// production: by Next's own server (self-hosted, `next start`), and by OpenNext's Worker on
// Cloudflare, which tests the regex Next writes into its routes manifest, with case.
import { describe, expect, it } from "vitest";
import { buildCustomRoute } from "next/dist/lib/build-custom-route";
import { modifyRouteRegex } from "next/dist/lib/redirect-status";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import nextConfig from "../next.config";

type Rule = { source: string; headers: { key: string; value: string }[] };

async function rules(): Promise<Rule[]> {
  return (await nextConfig.headers!()) as Rule[];
}

// The headers an address gets, each matching rule's in order, a later one's replacing an
// earlier one's of the same name, as both servers do.
function headersBy(matches: (rule: Rule) => boolean, all: Rule[]) {
  const got: Record<string, string> = {};
  for (const rule of all) if (matches(rule)) for (const h of rule.headers) got[h.key] = h.value;
  return got;
}

// As Next's own server matches a header's source.
const byNext = (path: string, all: Rule[]) =>
  headersBy(
    (rule) =>
      Boolean(
        getPathMatch(rule.source, {
          strict: true,
          removeUnnamedParams: true,
          regexModifier: (regex: string) => modifyRouteRegex(regex),
          sensitive: Boolean(nextConfig.experimental?.caseSensitiveRoutes),
        })(path),
      ),
    all,
  );

// As OpenNext's Worker matches one: the manifest's regex, with no flags.
const byOpenNext = (path: string, all: Rule[]) =>
  headersBy((rule) => new RegExp(buildCustomRoute("header", rule).regex).test(path), all);

const EMBED = { "Content-Security-Policy": "frame-ancestors *" };
const SAME_SITE = { "Content-Security-Policy": "frame-ancestors 'self'", "X-Frame-Options": "SAMEORIGIN" };

const embeds = [
  "/chrismdp/counting-house-rung-1-off/embed",
  "/chrismdp/counting-house-rung-1-off/v/1/embed",
  "/chrismdp/systems/counting-house/embed",
  "/acme/dinners/v/12/embed",
  "/a/b/embed",
];

const others = [
  "/",
  "/login",
  "/settings",
  "/settings/tokens",
  "/gallery",
  "/consent",
  "/chrismdp",
  "/chrismdp/counting-house-rung-1-off",
  "/chrismdp/counting-house-rung-1-off/security",
  "/chrismdp/counting-house-rung-1-off/platform",
  "/chrismdp/counting-house-rung-1-off/v/1",
  "/chrismdp/counting-house-rung-1-off/v/1/workflow.yaml",
  "/chrismdp/systems/counting-house",
  "/chrismdp/systems/counting-house/checks",
  "/acme/settings",
  "/acme/inventory",
  // Pages whose own names say embed: an implementation, a platform and a system called embed,
  // and the old addresses of platforms.
  "/chrismdp/dinners/platform/embed",
  "/chrismdp/dinners/v/1/platform/embed",
  "/chrismdp/platforms/embed",
  "/chrismdp/systems/embed",
  "/chrismdp/platforms/v/v/embed",
  "/chrismdp/systems/v/v/embed",
  "/platforms/chrismdp/embed",
  "/platforms/chrismdp/v/v/embed",
  // Routes that catch everything under them.
  "/api/auth/embed",
  "/api/auth/v/1/embed",
  "/.well-known/oauth-protected-resource/a/embed",
  "/api/v1/chrismdp/dinners",
  "/mcp",
  // Not quite an embed's address: another case, a version that isn't a number, more after it.
  "/chrismdp/dinners/EMBED",
  "/Chrismdp/dinners/embed",
  "/chrismdp/SYSTEMS/home/embed",
  "/chrismdp/dinners/v/one/embed",
  "/chrismdp/dinners/embed/more",
  "/chrismdp/dinners/%65mbed",
];

describe("who may frame a page", () => {
  it("lets any site frame an embed page, with no X-Frame-Options", async () => {
    const all = await rules();
    for (const path of embeds) {
      expect(byNext(path, all), path).toEqual(EMBED);
      expect(byOpenNext(path, all), path).toEqual(EMBED);
    }
  });

  it("lets only the site itself frame any other address, sign-in and settings included", async () => {
    const all = await rules();
    for (const path of others) {
      expect(byNext(path, all), path).toEqual(SAME_SITE);
      expect(byOpenNext(path, all), path).toEqual(SAME_SITE);
    }
  });
});
