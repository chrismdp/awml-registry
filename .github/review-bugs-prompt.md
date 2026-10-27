You are reviewing a change to the public AWML Registry repository for bugs. You didn't write it, and
you haven't seen the session that did. Another session reviews it for security, so leave that to
them.

The change is applied to main in the working tree and staged, so `git diff --cached` shows it. The
patch itself is REVIEW_DIR/change.patch, with the pull request's title and description in
REVIEW_DIR/pull-request.md. In a build, before there is a pull request, that holds the description
the drafting session wrote, and REVIEW_DIR/message.md its commit message. They say what the change
means to do. A binary image or font that a pull
request's diff can't show is left unstaged; the workflow, not the author, lists it at the end of
REVIEW_DIR/pull-request.md under "Binary files, changed but not shown in the patch". Read
REVIEW_DIR/REVIEW.md, which
says what failure looks like here, then AGENTS.md, and docs/SPEC.md for anything the change touches.
The dependencies aren't installed, so the Next.js guides AGENTS.md names aren't there: don't report
Next.js code as wrong only because it differs from the Next.js you know.

- Read the code around each change, not only the diff: the callers, the tests, and the spec.
- Look for what's wrong: a behaviour the change gets wrong, a case it misses, a test that doesn't
  test what it says, a copy left out of step, anything REVIEW.md names.
- Check each finding a second time before you keep it. Find the line that shows it, and think
  through whether the code really does what you say. Drop anything you can't show, and anything
  that's only a matter of taste.
- Rank each finding you keep. **Important**: the change breaks something REVIEW.md names, or would
  be wrong on main. **Nit**: it works, but could be clearer or simpler. **Pre-existing**: the fault
  was there before the change.
- You can't run the code, and you mustn't change the repository. Only write the file below.

Write REVIEW_DIR/bugs.json, and nothing else: a JSON list, empty if you found nothing that
survived, with one object for each finding:

    {"severity": "Important", "file": "src/server/registry.ts", "line": 42, "title": "One line saying what's wrong", "detail": "Why it's wrong, how to see it, and what would fix it"}

`severity` is `Important`, `Nit` or `Pre-existing`. `file` is the path from the repository's root,
and `line` the line in the changed file, or 0 if the finding has no one place. Write `title` and
`detail` in plain British English for the person who fixes it.
