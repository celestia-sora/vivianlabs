---
name: vivian-release-sync
description: Automatically finalize every completed Vivian implementation task by synchronizing the in-app version display, AGENTS.md, and README.md with verified repository changes. Use after coding tasks, bug fixes, refactors, features, dependency changes, and release preparation.
---

# Vivian Release Sync

## Mandatory trigger

Run this workflow at the end of every assigned implementation task, after the code changes and relevant tests are complete, and before reporting the task as finished. This is a repository-wide completion rule, not an optional release suggestion.

Do not run it for a task that only investigates or audits without changing the product. Do not bump the app version for documentation-only changes, this skill's own installation, failed/abandoned work, or changes that have not passed the applicable verification.

## Required completion workflow

1. Review the complete diff and identify the actual user-visible, architectural, operational, and developer-workflow changes.
2. Determine whether the app version should change using the version policy below.
3. If the version changes, update the version string in the in-app **ข้อมูลเวอร์ชัน** panel in `app/companion.tsx`. This is the user-facing source of truth. Search for the existing `Version` row; do not add a second version label.
4. Update `AGENTS.md`:
   - Remove or revise obsolete instructions that the implementation superseded.
   - Add the new architecture, contracts, constraints, commands, migrations, and verification steps that future agents need.
   - Preserve still-valid rules. Do not append contradictory historical instructions.
5. Update `README.md`:
   - Keep product behavior, feature descriptions, setup, API routes, migrations, and developer commands aligned with the implementation.
   - Remove claims that are no longer true.
   - Keep the overview concise and link to deeper docs where appropriate.
6. If a change affects package/runtime release metadata, inspect `package.json` and related platform manifests and synchronize only the metadata that the project actually uses. Do not blindly bump every manifest.
7. Run relevant tests and checks again after documentation/version edits where applicable. At minimum run `git diff --check`; run the relevant feature tests, typecheck, lint, and production build for code changes when the environment supports them.
8. Inspect the final diff and confirm the three required destinations were considered: UI version, `AGENTS.md`, and `README.md`. If the version is intentionally unchanged, record why in the task summary.
9. Commit the implementation and its documentation/version synchronization together in the task's working branch, following the repository's normal batching policy. Never push directly to `main` unless explicitly instructed.

## Version policy

Use the version already displayed in the UI as the baseline. Do not guess the next version from stale docs or package metadata.

- **PATCH** (for example, 2.4.2 → 2.4.3): bug fixes, reliability/performance improvements, internal refactors that preserve product contracts, and small polish.
- **MINOR** (for example, 2.4.3 → 2.5.0): meaningful user-facing capabilities, substantial workflow changes, or a new compatible product milestone.
- **MAJOR**: breaking product/API/data contracts or a deliberate major product generation.
- Documentation-only, tests-only, tooling-only, audit-only, and incomplete changes do not bump the app version.
- Do not skip versions or invent a codename. Preserve the current codename unless the task explicitly changes it.
- If the change spans multiple categories, choose the smallest version increment that accurately communicates the shipped product impact.
- If it is unclear whether a change is a release-worthy product change, explain the uncertainty in the completion summary rather than silently inventing a version.

## Documentation accuracy rules

- Derive statements from the final code and verified tests, not from the task request or intended design.
- Distinguish implemented, partially implemented, planned, and unavailable behavior.
- Include required database migrations and deployment/configuration steps when applicable.
- Never claim a deployment succeeded unless deployment status was checked.
- Never claim tests passed unless they were actually run and passed.
- Do not copy secrets, tokens, personal data, or private production values into docs.
- Preserve existing user-facing terminology and Thai UI labels, including **ข้อมูลเวอร์ชัน**.
- If a task intentionally changes the architecture (for example, replacing the persona prompt architecture), update old agent rules so they do not force agents to recreate the retired design.

## Completion report

Report:
- UI version before → after, or why unchanged.
- What changed in `AGENTS.md`.
- What changed in `README.md`.
- Tests/checks actually run and their results.
- Any remaining manual deployment, migration, or release action.
