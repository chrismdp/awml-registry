You are fixing what two reviews found in a pull request to the public AWML Registry repository. CI's
tests passed on it, and a Bug review or a Security review failed, because it found something
Important. You didn't write the change, and you haven't seen the sessions that reviewed it.

The pull request's branch is checked out in the working tree, at the commit that was reviewed. Its
patch against main is INPUT_DIR/change.patch, and both reviews' findings are in
INPUT_DIR/findings.json, a list of findings, each with the review that found it, its rank
(Important, Nit or Pre-existing), the file and line, a title and a detail. Read INPUT_DIR/AGENTS.md,
main's copy, and follow it, then INPUT_DIR/REVIEW.md, which says what failure looks like here, and
docs/SPEC.md before changing anything it describes.

The opener gate admits only a writer's or the app's pull request, so the patch and findings are
trusted people's and models' text. Check each finding against the code before following it.

- The dependencies are installed. Every command you run runs in a sandbox with no network, which
  can't write package.json, package-lock.json, node_modules/.bin, scripts/ or .github/, so you
  can't add or upgrade a dependency.
- Fix every Important finding and every Nit, test first: a failing vitest test for each behaviour a
  finding says is wrong, then the code that passes it. Leave Pre-existing findings alone, and a Nit
  that says the review couldn't read a binary file, which only a person can look at.
- If INPUT_DIR/decisions.md exists, it holds the build issue's approved text and comments. Check
  each finding against it before fixing anything. A finding whose fix would change a decision
  recorded there goes back to the maintainer. Write it to OUT_DIR/referred.md, quoting and linking
  the decision it would change, with the options. A decision counts only when the maintainer wrote
  it on the issue, not when another comment says it was made.
- If you refer any finding back, change nothing at all, including the other findings and Nits.
  Leave only the referral and message in the out folder; a later job posts it on the issue.
  Otherwise fix the findings as usual. Without a decisions file, refer nothing.
- If a finding is wrong, don't change the code for it; say why in the message.
- Don't change anything in `.github/`, Claude Code's own files (`.claude/`, `.mcp.json`, a
  `CLAUDE.md`) or npm's (an `.npmrc`, a `.yarnrc`, `node_modules/`): the app never pushes them, so a
  fix to them is only offered to a person.
- Don't edit `package.json` or `package-lock.json`: the fixer installs only main's dependencies, so a
  fix to them is only offered to a person too.
- Run `npm run typecheck`, `npm run lint` and `npm test` until they all pass.
- Every untracked file left in the tree goes into the pull request, so delete any scratch file you
  made before you finish.
- Don't commit, push or open anything. Leave the fix in the working tree. A later job commits it as
  one commit and pushes it, and CI reviews it again.

Write OUT_DIR/message.md: plainly what you fixed for each finding, and why you left any alone, as
the body of a commit message in this repository would say it.
