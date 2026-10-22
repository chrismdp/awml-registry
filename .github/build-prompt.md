You are building the change that one issue of the AWML Registry repository asks for. The maintainer
added the `build` label, or one of the repository's own workflows started the build, which says it
is wanted now.

The issue, with only the comments of the repository's own people, is in BUILD_DIR/issue.md. Read
it, then read AGENTS.md and follow it, and read docs/SPEC.md before changing anything it describes.
The dependencies are already installed, so the Next.js guides AGENTS.md points to are in
node_modules/next/dist/docs/. If issue.md ends with a section saying the last try failed, your job
is to make a change that passes where that try failed, not to start over without a reason.

- If the issue leaves a choice open, build what the maintainer decided in their comments. If they
  haven't said which option they chose, change nothing, and say so in the message.
- Test first: write a failing vitest test for each behaviour before the code that passes it.
- Keep docs/SPEC.md true. A change to what the registry does updates the spec in the same change,
  with the date it was decided, as the spec's own entries do.
- Keep the access rules in docs/SPEC.md's "Access" section. A private workflow or platform is seen
  only by its organisation's members; anyone else gets the same 404 as for one that doesn't exist,
  and an invalid token gets the same 401 whatever it asks for. A change that touches who can read
  or push covers every boundary that section's table lists (positive, negative, cross-tenant,
  invalid token, roles) with a test in test/security.test.ts or beside the existing ones.
- This repo has no billing code. Anything to do with payment belongs in the hosted service, not
  here; say so in the message instead of building it.
- Run `npm run typecheck`, `npm run lint` and `npm test` until they all pass.
- Don't commit, push or open anything. Leave the change in the working tree. A later job applies
  it, runs the checks again and opens the pull request.
- Something new that the issue doesn't ask for goes in the message as a suggested issue, not in
  the change.

If the change needs the maintainer's eyes, write BUILD_DIR/review.md and say why. It needs their
eyes if you made a decision the issue and its comments didn't settle, chose between options,
changed behaviour beyond what the issue asks, or aren't sure. Otherwise don't write that file.
Your note can send a change to review, but it can never skip a review required by the build rules.

Finally, write BUILD_DIR/message.md: a first line under 70 characters saying what changed, a blank
line, then plainly what changed and why, as a commit message in this repository would. Don't add
"Closes"; the next job adds it.
