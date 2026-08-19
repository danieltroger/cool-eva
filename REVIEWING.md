# How pull requests get reviewed

Reviews used to run as a GitHub Action on every PR. It billed an API key and cost about €50 in one active day, which bought nothing that was not already available on the maintainer's subscription. It is disabled — see the header of `.github/workflows/claude-code-review.yml` — and reviews run locally instead.

**The reviews are not being dropped.** They caught real bugs, including a liveness summary that would have reported a dead CAN bus as healthy, and a guard whose two halves contradicted each other so it could never fire. Only where they run has changed.

## Two rules

**1. Every PR gets one before it merges.** The failure mode is not a bad review, it is a forgotten one. This is now a person's or an agent's job to remember rather than a trigger that fires by itself, which is strictly worse for reliability — so it needs to be deliberate.

**2. Never review in the agent that wrote the code.** An author re-reading its own work re-runs the reasoning that produced the bug. The reviewer must arrive without the author's justifications, see the diff cold, and be free to conclude the whole approach is wrong.

## What the move cost

Rule 1 already says the new arrangement is strictly worse for reliability. Three more things CI did better, each of which is now a failure mode this document has to cover rather than a thing that took care of itself:

- **Provenance — the expensive one.** CI reviews arrived from `claude[bot]`, unambiguously not the author. Local reviews post under the maintainer's own login, the same one that authored the code and that posts the "all findings addressed" replies, so a thread now reads as the maintainer reviewing his own PR. That is why the check below can no longer filter by author — and it is why **rule 2 is unverifiable after the fact**: nothing in the record distinguishes "a fresh agent reviewed this" from "the author re-read it". Rule 2 is the more important of the two rules and it is the one that lost its evidence. Nothing restores it; naming the reviewing model and the reviewed SHA in the review body is the most that can be done, so do that.
- **A clean checkout at a known SHA.** CI reviewed a fresh checkout of the merge ref. A local reviewer can review a dirty worktree, a stale head, or the wrong branch entirely, and nothing catches it. Hence the checkout step under "What to add locally".
- **It fired unprompted.** Covered by rule 1, and the reason rule 1 is first.

None of this argues for turning CI back on: the spend was real, and the reviews were not better for having run there. It argues that the mitigations _are_ the process, so what was lost belongs written down next to what was gained.

## Before merging

Check that **the last review predates the last commit**. If a review landed _after_ the final commit, nothing in the branch can have addressed it — the PR is carrying unread feedback no matter how green the checks are.

    # the last commit on the branch
    gh api repos/OWNER/REPO/pulls/N/commits -q '[.[].commit.committer.date]|last'

    # every surface a review can land on, any author, newest last
    { gh api repos/OWNER/REPO/issues/N/comments -q '.[]|"\(.created_at)\tcomment\t\(.user.login)"'
      gh api repos/OWNER/REPO/pulls/N/reviews  -q '.[]|select(.submitted_at)|"\(.submitted_at)\treview\t\(.user.login)"'
      gh api repos/OWNER/REPO/pulls/N/comments -q '.[]|"\(.created_at)\tinline\t\(.user.login)"'
    } | sort | tail -10

⚠️ **Do not filter by author, and do not use `issues/N/comments` alone.** The obvious `select(.user.login|test("claude|bot"))` is what this check said first and it cannot work any more: `claude[bot]` is gone, and a local reviewer posts under the maintainer's own `gh` auth. Run against this repo it returns an hour-old CI comment on #87 — not the local review that followed it — and **nothing at all** on #89, #90 and #91, which are exactly the PRs the new process produced. `issues/N/comments` also returns issue comments only, so a review posted purely as inline comments, which the prompt below asks for, is invisible to it.

The price of dropping the filter is that the listing mixes reviews in with the author's own replies and **nothing in the data separates them** — that is the provenance loss above, showing up as a concrete inconvenience. Read the last few lines and judge; there is no longer a query that answers this on its own.

This is not hypothetical. PR #77 merged two minutes after a review that opened with _"A is the one I'd fix before merge"_, and the finding was a real data-integrity bug — an all-ones payload decoding to 255 A on the only DC charge current on the bus, passing every bounds check. Green checks do not detect a review nobody read.

⚠️ A PR opened while conflicting with something that lands mid-flight appeared to have its `pull_request` workflows **silently suppressed** — observed once here, not read in any documentation, and the mechanism is a guess (GitHub builds `refs/pull/N/merge`, and an unmergeable PR has no merge ref). Either way "no review ran" and "the review passed" look identical from the outside, so check that one happened at all.

"I read it and it is not actionable" is a fine outcome. Silence is not.

## The prompt

**Adapted** from the workflow, not verbatim. The review focus is word for word; the posting instructions are not:

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

Three deliberate differences from the CI version, recorded because "adapted" is only honest if it says what changed:

- `mcp__github_inline_comment__create_inline_comment` became "the pull-request comments API" — the MCP tool does not exist outside the action.
- _"Only post GitHub comments — don't submit review text as messages"_ (a prohibition) became _"Post your findings as GitHub comments on the PR"_ (a requirement). Not the same instruction. The prohibition earned its place in CI, where a review left in the transcript died with the runner; locally the transcript survives, but a review nobody can link to is still not a review.
- **_"The PR branch is already checked out in the current working directory"_ was dropped, because it was true in CI and is false locally.** That is the one line whose loss changes what the reviewer does, so it comes back as the first item below rather than disappearing.

Run it on Opus. The prompt is deliberately generic — the quality came from the model, not from the wording, and nothing here is worth tuning before it has demonstrably failed at something.

## What to add locally, because CI could not

The CI reviewer's own words, more than once: _"I could not execute here, so the passing test run remains your report."_ A local reviewer should not accept that limitation.

- **Check out the PR head first, and name the SHA you reviewed.** `gh pr checkout N`, or `git worktree add` if the main checkout should be left alone. In CI this was free and the prompt said so; nothing does it for you now. The failure it prevents is specific and silent: `npm ci && npm test` on `main` produces a green suite that says nothing whatever about the branch, inside a section whose entire argument is that running the suite is the advantage. Open the review with the SHA — _"Review of `0807855` — …"_ — so the claim stays checkable after the branch moves.
- **Run the checks.** `npm ci`, then `npm test`, `npx tsc --noEmit`, `npx prettier --check .`. Verify claims rather than believing them. ⚠️ `prettier --check` fails spuriously on a drifted `node_modules` — the lockfile pins the version, so `npm ci` first.
- **Use the whole repo and its history**, not just the diff. A change that makes a comment elsewhere false is a defect here; so is re-introducing something an earlier PR retracted.
- **Re-measure data claims** against the capture archive. Several confident and wrong decodes have shipped on this project. A reviewer who can check the numbers is worth far more than one who can only read them.
- **Take as long as it needs.** There is no ten-minute cap.

## House standards worth stating to the reviewer

- Comments explain _why_, not _what_, and are load-bearing.
- A guard that cannot fire is a bug, not a nitpick.
- A new check should be mutation-tested — undo the thing it guards and confirm it goes red. If that was not demonstrated, ask for it.
- Prefer "unknown" to a plausible guess. An honest gap beats a confident error.
