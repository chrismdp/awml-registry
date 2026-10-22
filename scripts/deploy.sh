#!/usr/bin/env bash
# Deploys the registry to Cloudflare with the settings in wrangler.jsonc:
# applies D1 migrations, builds with OpenNext and deploys the Worker. Secrets
# are set once with `wrangler secret put`; the README's "Run it on Cloudflare"
# lists them.
set -euo pipefail
cd "$(dirname "$0")/.."
npx wrangler d1 migrations apply awml-registry --remote
npm run cf:build
npx wrangler deploy
