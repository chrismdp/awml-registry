#!/usr/bin/env bash
# Deploys the hosted registry to Cloudflare: applies D1 migrations, builds with
# OpenNext and deploys the Worker. Secrets are set once with `wrangler secret put`.
set -euo pipefail
cd "$(dirname "$0")/.."
npx wrangler d1 migrations apply awml-registry --remote
npm run cf:build
npx wrangler deploy
