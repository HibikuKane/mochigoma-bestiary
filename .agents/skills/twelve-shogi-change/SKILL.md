---
name: twelve-shogi-change
description: Plan, implement, and hand off purpose-scoped changes in HibikuKane/mochigoma-bestiary through a feature branch and reviewed PR. Use for this repository's requested development or session handoff.
---

# Twelve Shogi: change workflow

Use the repository's `AGENTS.md` and [CONTRIBUTING.md](../../../CONTRIBUTING.md) as the workflow source. Read [goals](../../../docs/project-goals.md), [roadmap](../../../docs/roadmap.md), and [handoff](../../../docs/handoff.md) for task context; inspect current remote state because the handoff is dated.

## Start a bounded change

- Distinguish discussion/diagnosis from implementation authorization. A queued roadmap item is not a request to build it.
- State the user problem, intended outcome, included scope, and observable acceptance conditions. Treat unagreed details as provisional decisions, not new project requirements.
- Create a task branch from current remote `main`; resume only the branch for the same existing purpose. All subsequent writes must explicitly target that branch. No direct `main` commits, pushes, ref updates, or protection bypasses.

## Preserve this project's boundaries

Keep deterministic rules apart from DOM/UI, typed game events apart from localized copy, and future run state apart from match state. Add player-visible text in all three language dictionaries. Preserve the current comparison ruleset. Put experiments and development plans in documents rather than inert in-game controls.

For relevant mechanics, read existing tests and add meaningful regression coverage before changing behavior. Use the established scripts for tests and build. Record browser/deployment/phone verification separately, including any blocked checks; a green build is not proof of a playable deployment.

## Deliver through review

Use the repository PR template to explain why each meaningful change serves the stated outcome. Open a Draft PR when incomplete or blocked. Request an independent agent/session review with [twelve-shogi-review](../twelve-shogi-review/SKILL.md), or the user-designated human reviewer. Supply the user's objective, base/head revisions and actual diff; do not tell the reviewer which verdict to return.

Address blocking findings and seek review of changed portions. Record the reviewer, reviewed revision, findings/disposition, and actual checks in the PR. If independent review is unavailable, leave it visibly pending. Do not represent same-account AI review as a separate GitHub approval.

End with a reviewable PR. Merge only with explicit user authorization for that PR and after its actual merge gates are satisfied. Update the handoff with proposed versus merged state, evidence, blockers, and the next bounded task. Do not hold the handoff indefinitely for browser calls that are not returning; follow the bounded-check guidance in `CONTRIBUTING.md`.
