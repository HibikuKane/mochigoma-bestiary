---
name: twelve-shogi-review
description: Independently review a mochigoma-bestiary PR for whether its actual changes fulfill the stated purpose, stay in scope, and preserve game and repository constraints. Use when assigned a review rather than implementation.
---

# Twelve Shogi: independent review

Read `AGENTS.md` and [CONTRIBUTING.md](../../../CONTRIBUTING.md). Read [goals](../../../docs/project-goals.md) and [roadmap](../../../docs/roadmap.md) when deciding purpose-fit. You must be a separate reviewer from the implementer; a single agent changing roles is self-review, not independence.

## Establish the review target

Get the original user objective, PR purpose/acceptance conditions, base/head revisions, actual diff, and validation evidence. Missing revision or diff is an evidence gap. A local review before commit may identify its base SHA and exact file set; when the unchanged reviewed files are committed, the implementer must bind the report to that revision.

Inspect the files yourself. Do not approve solely from the implementer's description or test count. Review is read-only unless specifically asked to fix; return findings to the implementer.

## Judge the change

- Does the work achieve the requested outcome, and is each substantial change justified by that purpose?
- Does it quietly decide an open design question or combine multiple experiments?
- Are deterministic rules/UI, match/run state, and typed events/localization kept separate?
- Are all three in-game languages, mobile input, and the actual implemented feature set represented honestly where affected?
- Does the evidence cover the concrete risks? Check state transitions, asynchronous results after reset, and game termination when relevant; don't require unrelated tests for a documentation change.
- Does the branch/PR/merge procedure respect the repository rules? Separate an AI review report from an actual GitHub approval and distinguish configured protection from written policy.

## Report

Record the reviewed revision or local scope, overall purpose-fit judgment, findings with file/location and impact, severity (`blocker`, `follow-up`, `nit`), and evidence/limits. End with `changes requested`, `no blocking findings`, or `blocked / insufficient evidence`.

For each blocker, state what must be true to resolve it without demanding an unnecessarily specific implementation. Do not pad a clean review with invented issues. Do not claim tests, UI interaction, deployment, or formal approval that you did not perform.

After revisions, review affected changes and identify which previous findings are resolved. Do not merge, change protection, or post under another identity. Return the report to the implementer; post to GitHub only if that review action is authorized.
