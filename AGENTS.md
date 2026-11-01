<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## The factory's scripts

A pull request's own `.github/workflows/ci.yml` runs main's copies of the scripts in `.github/` that it calls, such as `claude-settings.sh`, `bring-patch.sh` and `scan-tokens.sh`, copied out of main before the branch is read. So a change to one of those scripts' arguments or output keeps the old form working until the change is on main, and the branch's `ci.yml` calls only what main's copies already take. `test/factory-workflows.test.ts` rehearses `ci.yml` with `origin/main`'s copies.

## Working through issues

- **A review finding or failing test whose fix would change something the maintainer decided on the issue goes back to the maintainer,** with the options, instead of being fixed. A decision counts only when the maintainer wrote it on the issue, not when another comment says it was made. The fixer reads only a build's issue, so on any other pull request its author refers the finding or failing test back, and reverts any fix that already undid the decision.
- Failed tests and Important review findings go to `fix.yml`, which fixes the existing pull request in one session, up to two fix commits on a branch. Removing and re-adding the `build` label starts a fresh build.
