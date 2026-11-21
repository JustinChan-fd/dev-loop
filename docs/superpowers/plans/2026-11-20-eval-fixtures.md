# Eval fixtures: plan

Spec: `docs/superpowers/specs/2026-11-20-eval-fixtures-design.md`. Branch `feat/eval-fixtures`, off `main` (`4a59aaa`).

Each task is RED (the failing test, run and seen failing) then GREEN (the minimum code). The suite, `test:hooks` and `tsc` are green at each commit.

1. **Paths.** `FIXTURE_NAME`, `v2FixtureRunDir`, `v2FixtureRunsLog` in `src/core/paths.ts`. Test: `test/core/paths.test.ts`.
2. **Spawn deny tools.** `denyTools` on `SpawnClaudeOpts`, merged into `settingsJson`'s `permissions.deny`, validated against a tool-pattern allowlist. Test: `test/core/spawn-claude.test.ts`.
3. **Fixture types and validators.** `src/eval/fixture.ts`: `validateTicket`, `validateRepoPin`, `loadFixture` (refuses a missing ticket, `reviewed: false`, or an unverified or null pin). Test: `test/eval/fixture.test.ts`.
4. **Grader.** `src/eval/grade-fixture.ts`: `validateExpectation`, `phaseEndsBefore`, `gradeRun`, `aggregate`. Test: `test/eval/grade-fixture.test.ts`.
5. **Replay tests.** `test/fixtures/replay/<4 runs>/` (paths scrubbed) and `test/roles/research/verdict-replay.test.ts`.
6. **Outbox client.** `src/eval/outbox.ts`: `OutboxJiraClient`. Test: `test/eval/outbox.test.ts`.
7. **Leak guard.** `src/eval/guard.ts`: `fixtureSpawnGuard`, `FIXTURE_DENY`, `pinnedGit`. Test: `test/eval/guard.test.ts`.
8. **Pinning.** `src/eval/pin-repo.ts`: `pinWorktree`, with an injected git. Test: `test/eval/pin-repo.test.ts`.
9. **Runner.** `src/eval/fixture-run.ts`: `parseFixtureArgs`, `planFixtureRun`, `runFixture` (injected deps: `makeRunSkill`, `runResearchPhase`, outbox, grade, log), the dry plan, and the live refusal. Test: `test/eval/fixture-run.test.ts`.
10. **Save.** `src/eval/jira-read.ts` and `src/eval/fixture-save.ts`: `scrubTicket` (pure) and `saveFixture` (injected reader and fs). Test: `test/eval/fixture-save.test.ts`.
11. **Wiring.** `evals/run.sh` takes `--fixture=<name>` (dry: plan; live: through `outward`), `package.json` gets `fixture:save`, and `evals/fixtures/{mc-1435-xl,mc-1718}/` get `repo.json`, `expect.json` and `PENDING.md`. Test: `test/evals/harness.test.ts` (dry `--fixture` calls no stub).
12. **Skill.** A `## Fixture mode` section in ticket-refine's SKILL.md, and one line in `recon-agent.md`. Test: `test/structure.test.ts`'s path check.
13. **Docs.** `evals/README.md` (Fixture evals), `docs/projects/dev-loop-eval-sandbox.md`, the guide's `DATA` (the eval repo entry), the `README.md` pointer, the CHANGELOG `[core]` entry, and `docs/future-enhancements.md` (the guard hook).
14. **Fresh review** of the whole branch. Fix Critical and Important findings, then do the pillar check.
