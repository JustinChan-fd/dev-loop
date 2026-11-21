# CLAUDE.md — dev-loop

One repo, two phases of an agentic Jira pipeline. The default `--phase=worker`
runs both on one session (research, then dev, on the same ticket);
`--phase=research|dev` runs one. Each phase has its own stance. Apply the stance
of the phase/skill you are working in, not the other.

## Research phase (`ticket-refine`)

The research spawn runs from this repo root but excludes this file
(`claudeMdExcludes`) and loads its stance from `src/roles/research/stance.md`
via `--append-system-prompt`. Edit the stance there, not here.

- **Treat every raw ticket as an unverified claim.** Produce a ticket a
  literal-minded Sonnet-tier implementer can execute without asking a question,
  or bounce it with concrete evidence of why it isn't ready.
- Ground claims against the actual codebase (`recon-agent`), attack your own
  assumptions (`devils-advocate-agent`), and verify independently
  (`verifier-agent`).

## Dev phase (`ticket-to-pr`, `qa-agent`)

- **Trust the ticket completely.** By the time a ticket reaches the "ready"
  epic it has been refined and human-reviewed. Never relitigate the spec,
  acceptance criteria, or scope. If something can't be reasoned to from the
  ticket's description + comments, **bounce with concrete evidence** — do not
  guess, infer, or "helpfully" expand scope.
- **TDD, strictly.** Every acceptance criterion gets a failing test first
  (RED), committed before any implementation, then the minimum code to pass
  (GREEN).

## The pillar: agents judge, the loop does the mechanics

**IMPORTANT. Follow this in every design and change; refine it as we learn.**

- **Agents do the work that needs judgment.** Reading and grounding a
  ticket, planning, writing the tests and the code, QA, writing the PR
  title and body. They hand the result over in `verdict.json`.
- **The loop does everything mechanical, in plain TypeScript, with tests.**
  Jira status moves, QA Notes fields, comments, signing commits, cleanup,
  reset. These must never depend on an LLM's read of the situation on a
  given day. An agent stuck mid-cleanup, or one that "reasons" about a Jira
  transition, is the failure mode this pillar exists to prevent.
- **When an agent must run a mechanical step,** keep it on the cheapest
  tier (haiku), with templated, literal instructions. Today that's only
  the operator's push-branch skill, the one copy of the push and PR steps,
  which the loop must not duplicate. The agent gets the content already
  written and has nothing to decide.
- **The handoff is a contract.** The agent says what it did and what's
  ready (a verdict). The loop checks that against facts (git, Jira, GitHub)
  before acting on it, and refuses rather than guessing.
- **Security follows the same line.** Credentials and signing keys stay
  with the loop on the host. A sandboxed agent produces work but never
  decides what gets signed or published.
- **Long unattended work runs in a sandbox, and you're asked first.**
  Sandbox or host is the user's call, each session. Before anything that
  runs without the human (an overnight build, a loop batch, a long eval),
  the host session or orchestrator offers `npm run claude:sbx` first,
  naming what the sandbox can reach. The overnight launcher only starts
  inside a sandbox. Running unsandboxed is an explicit choice, never the
  default, and is written down. The same holds for dev-loop's own code:
  two ways to start a session are in README, "Starting a session".
- **Every change reaches main through a PR the user merges.** `main` on
  GitHub requires a PR (no direct push, no force-push, enforced for admins).
  A sandboxed session never pushes: `claude:sbx:sync` brings its branches
  back re-signed, and the user pushes and opens the PR.
- **Before every merge, check the pillars.** At the end of a session or a
  large group of changes, list each change against each pillar above (and
  TDD, "a bounce beats a guess", "plain loop unchanged"): breaks, bends or
  fine, with why. Fix a break before merging. Write a bend down in the
  merge commit or CHANGELOG with the reason it is acceptable.

## The guide page

`docs/guide/how-dev-loop-works.html` is the plain-language picture of the
loop, with option chips for repo, job, sandbox and mode. **Update it in the
same change** when you change a CLI flag, a sandbox adapter, a supported
repo (`pipeline.*.config.json`), a phase's steps, or what runs where. Its
facts live in the `DATA` block at the top of its script.
**The guide has its own version.** Every change to `docs/guide/` bumps
`DATA.guideVersion`, sets `DATA.updated` (and `DATA.loopVersion` if
package.json moved), and adds an entry at the top of
`docs/guide/guide-changes.js`, which `docs/guide/changelog.html` shows
("What's new"). Patch: a wording fix. Minor: a new section, step or repo.
Major: a restructure. `test/guide/guide-version.test.ts` fails when a branch
changes `docs/guide/` without a higher version than main's, or when the page and
the newest entry disagree. `DATA.loopVersion` may lag package.json (it says what
the page was last checked against), never lead it.
A push to main that touches `docs/guide/` republishes it to GitHub Pages
(`.github/workflows/guide-pages.yml`): https://justinchan-fd.github.io/dev-loop/

## Both phases

- **A bounce is a success, not a failure.** `outcome: "bounced"` with good
  evidence is correct. Guessing is the actual failure mode.
- TDD applies to this repo's own code too. `npm test`, `npm run test:hooks`
  and `npx tsc --noEmit` must be green before and after any change to `src/`
  or `.claude/hooks`.

## Before you touch code

- Read `docs/skills.md` before editing `.claude/skills/*/SKILL.md` or
  `.claude/agents/*.md` — those are the actual pipeline logic.
- Read `docs/config.md` before touching `src/core/config.ts`, the `Config`
  shape in `src/core/types.ts`, or any `pipeline.*.config.json` file.

## Docs map

Each doc has `## Research phase` and `## Dev phase` sections.

- `docs/config.md` — config shape, Appendix A, adding a new project.
- `docs/skills.md` — what each phase's skills and subagents do, the invocation
  contract (`/<skill> <KEY> run-dir=<abs> repo-dir=<abs>`), verdict.json contract.
- `src/roles/research/stance.md` — the research phase's stance (its CLAUDE.md).
- `docs/logging.md` — `runs/<project>.jsonl`, per-run `progress.jsonl`,
  `.pipeline/` layout, the `stats` script.
- `docs/sandbox-sbx.md` — setting up the sbx sandbox adapter (kit, node, secrets,
  discover run), and "Dev-loop sessions": `npm run claude:sbx` vs plain
  `claude --dangerously-skip-permissions`, and `claude:sbx:sync`.
- `docs/adapters/sbx/` — sbx how-tos (`templates.md`: build, update, roll back
  the sandbox template from `sandbox/sbx/template.sh`).
- `docs/guide/how-dev-loop-works.html` — the plain-language, interactive picture
  of the loop (repos, flags, sandbox). Keep it current (see "The guide page").
- `docs/projects/` — the registry of supported target repos (README table) and
  each one's layout and quirks.
- `docs/reset.md` — `npm run reset-project`; use it to start a ticket or project
  fresh instead of hand-rolling `rm -rf`/`grep -v`.
- `docs/future-enhancements.md` — ideas not yet drafted into a change. When one
  lands, move it to `CHANGELOG.md` and delete it here.
- `docs/migration-ledger.md` — every divergence resolved when merging the two repos.
- `CHANGELOG.md` — fixes/behavior changes to the pipeline itself (not the tickets
  it processes). Add an entry whenever you fix a bug a human had to diagnose
  from a real run. Tag each bullet `[core]`, `[research]`, `[dev]` or `[hooks]`.
  Pre-2.0.0 history: `docs/changelog/`.
- `docs/superpowers/` — dated specs and plans.
