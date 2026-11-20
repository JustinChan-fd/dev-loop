# Supported projects

A project is **supported** when it has a `pipeline.<project>.config.json`, a
doc here, and at least one landed PR (or, for the eval repo, a passing eval).
This table is the registration: a project is supported when its row says so.

| Project | GitHub | Jira label | Default branch | Sandboxes | Status | Doc |
|---|---|---|---|---|---|---|
| [webtarsthree](webtarsthree.md) | `fandango/webtarsthree` | `repo:webtarsthree` | `master` | none, sbx | supported | [webtarsthree.md](webtarsthree.md) |
| [catalog-ui-management](catalog-ui-management.md) | `fandango/catalog-ui-management` | `repo:catalog-ui-management` | `main` | none, sbx | onboarding (until its first landed PR) | [catalog-ui-management.md](catalog-ui-management.md) |
| catalog-ui-public | `fandango/catalog-ui-public` | `repo:catalog-ui-public` | `main` | none | not supported (v1 labels, research only) | — |
| [dev-loop-eval-sandbox](dev-loop-eval-sandbox.md) | `JustinChan-fd/dev-loop-eval-sandbox` | `repo:dev-loop-eval` | `master` | none, sbx | eval | [dev-loop-eval-sandbox.md](dev-loop-eval-sandbox.md) |

How a project's layout reaches the loop: the config's optional
`targetRepo.local` block (`docs/config.md`). A project with none is run the
way webtarsthree is: `package.json` at the root, host Node, root
`.envrc.example`.
