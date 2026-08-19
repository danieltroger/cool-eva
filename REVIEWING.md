# How pull requests get reviewed

Reviews used to run as a GitHub Action on every PR. It billed an API key and cost about €50 in one active day, which bought nothing that was not already available on the maintainer's subscription. It is disabled — see the header of `.github/workflows/claude-code-review.yml` — and reviews run locally instead.

**The reviews are not being dropped.** They caught real bugs, including a liveness summary that would have reported a dead CAN bus as healthy, and a guard whose two halves contradicted each other so it could never fire. Only where they run has changed.

## Two rules

**1. Every PR gets one before it merges.** The failure mode is not a bad review, it is a forgotten one. This is now a person's or an agent's job to remember rather than a trigger that fires by itself, which is strictly worse for reliability — so it needs to be deliberate.

**2. Never review in the agent that wrote the code.** An author re-reading its own work re-runs the reasoning that produced the bug. The reviewer must arrive without the author's justifications, see the diff cold, and be free to conclude the whole approach is wrong.

## Before merging

Check that **the last review predates the last commit**. If a review landed _after_ the final commit, nothing in the branch can have addressed it — the PR is carrying unread feedback no matter how green the checks are.

    gh api repos/OWNER/REPO/pulls/N/commits -q '[.[].commit.committer.date]|last'
    gh api repos/OWNER/REPO/issues/N/comments \
      -q '[.[]|select(.user.login|test("claude|bot"))]|last|.created_at'

This is not hypothetical. PR #77 merged two minutes after a review that opened with _"A is the one I'd fix before merge"_, and the finding was a real data-integrity bug — an all-ones payload decoding to 255 A on the only DC charge current on the bus, passing every bounds check. Green checks do not detect a review nobody read.

⚠️ A PR opened while conflicting with something that lands mid-flight has its `pull_request` workflows **silently suppressed**. "No review ran" and "the review passed" look identical from the outside. Check that one happened at all.

"I read it and it is not actionable" is a fine outcome. Silence is not.

## The prompt

Verbatim from the workflow, so nothing is lost in the move:

> REPO: `<owner/repo>` PR NUMBER: `<n>`
>
> Please review this pull request with a focus on:
>
> - Code quality and best practices
> - Potential bugs or issues
> - Security implications
> - Performance considerations
>
> Use `gh pr comment` for top-level feedback. Use the pull-request comments API to post inline comments on specific code issues. Post your findings as GitHub comments on the PR.

Run it on Opus. The prompt is deliberately generic — the quality came from the model, not from the wording, and nothing here is worth tuning before it has demonstrably failed at something.

## What to add locally, because CI could not

The CI reviewer's own words, more than once: _"I could not execute here, so the passing test run remains your report."_ A local reviewer should not accept that limitation.

- **Run the checks.** `npm ci`, then `npm test`, `npx tsc --noEmit`, `npx prettier --check .`. Verify claims rather than believing them. ⚠️ `prettier --check` fails spuriously on a drifted `node_modules` — the lockfile pins the version, so `npm ci` first.
- **Use the whole repo and its history**, not just the diff. A change that makes a comment elsewhere false is a defect here; so is re-introducing something an earlier PR retracted.
- **Re-measure data claims** against the capture archive. Several confident and wrong decodes have shipped on this project. A reviewer who can check the numbers is worth far more than one who can only read them.
- **Take as long as it needs.** There is no ten-minute cap.

## House standards worth stating to the reviewer

- Comments explain _why_, not _what_, and are load-bearing.
- A guard that cannot fire is a bug, not a nitpick.
- A new check should be mutation-tested — undo the thing it guards and confirm it goes red. If that was not demonstrated, ask for it.
- Prefer "unknown" to a plausible guess. An honest gap beats a confident error.
