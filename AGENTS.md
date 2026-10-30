# Working agreement for coding agents

This repository builds Mochigoma Bestiary, a web roguelike that uses twelve-shogi rules as its core ingredient (see [project goals](docs/project-goals.md)). Rule and balance hypotheses are still built cheaply, compared, and discarded as described in the [experiment charter](docs/experiment-charter.md).

## Required workflow (effective 2026-09-06)

- Never commit or push directly to `main`, including documentation, fixes, and agent instructions. Previous direct commits were bootstrapping only.
- Start each purpose-scoped change on a new branch from the current remote `main`; continue an existing task only on its own branch. Open a PR targeting `main`.
- Before implementation, state the problem, intended player/developer outcome, scope, and observable acceptance checks. A roadmap item is not automatic authorization to implement it.
- Every PR needs an independent reviewer. Use a separate agent/session or a user-designated human; do not label the implementer's own check as independent review. Review purpose-fit and scope as well as correctness.
- Record the reviewed code revision, findings, their disposition, and validation evidence in the PR. A change after review requires review of the affected changes before merge.
- Stop at a reviewable PR unless the user explicitly authorizes its merge. Never treat “implement/push/continue” as merge authorization. Verify the intended head before an authorized merge; do not bypass protection or force-update `main`.
- Follow [CONTRIBUTING.md](CONTRIBUTING.md) for review, merge, CI, and blocked-tool behavior. These rules apply even when repository protection is not configured.

## Start and handoff

- Read [project goals](docs/project-goals.md), [roadmap](docs/roadmap.md), and the current [handoff](docs/handoff.md). Inspect the actual remote branch/PR state before trusting a dated snapshot.
- For implementation or task handoff, use [twelve-shogi-change](.agents/skills/twelve-shogi-change/SKILL.md). For an independent PR review, use [twelve-shogi-review](.agents/skills/twelve-shogi-review/SKILL.md). If the harness does not discover repository skills automatically, read these files directly.
- Skills live in `.agents/skills/`; `.claude/skills/` is a symlink to it so Claude Code discovers the same files. [CLAUDE.md](CLAUDE.md) only points back here. Add or edit a skill in `.agents/skills/` and never keep a second copy under `.claude/`.
- Keep binding rules here, workflow detail in `CONTRIBUTING.md`, goals in `project-goals.md`, priorities in `roadmap.md`, and dated facts in `handoff.md`. Update the relevant source instead of copying the same plan everywhere.
- At session end, record the branch/PR, what is merged versus proposed, tests actually run, remaining uncertainty, and the next bounded task. Do not infer deployment success from a commit or build.

## Architecture

- Keep game rules deterministic and independent from the DOM.
- A ruleset owns initial state, legal action generation, and state transitions.
- Add or update tests before changing capture, promotion, check, try, drop, item, or fusion behavior.
- Do not add a UI framework, state library, backend, or asset pipeline without documenting why the current setup blocks the experiment.
- Prefer data-driven effects to one-off conditionals in UI code.
- Preserve usable mobile touch targets and keyboard-visible focus states.
- Keep all in-game copy in `src/i18n/` with matching Korean, Japanese and English entries. Game rules emit typed `GameEvent` data, never localized sentences. Switching locale must preserve the current match and selection.
- Keep development plans and speculative experiments in documents; only expose functioning player controls and relevant help in-game.
- Keep future run state (roster, stage, rewards) separate from single-match `GameState`. Early-stage enemies should start with fewer pieces than the player; exact setups are still undecided.

## Experiments

- Keep the classic ruleset available as the comparison baseline.
- Give each experiment one primary question.
- Record rejected experiments and the observation that rejected them.
- Prototype with CSS, text, emoji, or placeholders before requiring final art.
- Put generated art in `public/assets/<experiment-id>/` and record its model/source and license assumptions nearby.
- Core rules must not depend on image dimensions or frame-based animation.
