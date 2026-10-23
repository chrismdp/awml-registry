You are rebasing an open pull request onto one exact commit from `main` in the AWML Registry
repository. AGENTS.md's rules apply. Read it before changing anything, and read docs/SPEC.md before
changing anything it describes.

The material prepared for this rebase is in RESOLVE_DIR. Read `conflicted-files.txt`,
`pull-request.md`, `branch-log.txt` and `main-log.txt`, then inspect every conflicted file in the
working tree.

- Resolve the current commit's conflicts so both sides' changes survive. Never skip or drop a commit
  just to get past a conflict.
- Look for things the rebase broke without marking as a conflict. For example, a test may assert
  text that both sides changed. Fix those problems before continuing the rebase.
- If package-lock.json conflicts, take main's version, then run `npm install` so it matches
  package.json with both sides' dependencies, and add it.
- Keep docs/SPEC.md and its "Access" rules true to both sides: a private workflow or platform stays
  visible only to its organisation's members, and the tests for each boundary stay.
- Add the resolved files and run `git rebase --continue`. Repeat this for every
  commit that stops with conflicts, until the rebase finishes.
- At the end, run `npm ci`, `npm run typecheck`, `npm run lint` and `npm test` until they all pass.
- Don't push. A later job checks and pushes the rebased commits.
- If you can't resolve a conflict with confidence, run `git rebase --abort` and explain why in the
  message. Don't guess or discard either side.

Finally, write RESOLVE_DIR/message.md. Start with a short summary, then say plainly how you resolved
each commit's conflicted files and any related breakage you fixed. This note will be posted on the
pull request.
