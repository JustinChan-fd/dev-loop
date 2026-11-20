# sbx templates: build, update, roll back

A template is a saved sandbox disk that every loop sandbox starts from. It
holds what the kit can't supply (the kit is a `FROM scratch` mixin): node,
jq, direnv and git settings. It holds no direnv approval: each run's
sandbox allows only the loop's fake `.envrc`.

## Where it lives

Only on your Mac, in sbx's local image store (`sbx template ls`). It is not
in a repo and nothing is pushed. A sandbox is three layers:

| Layer | What | Changed by |
|---|---|---|
| Base image | sbx's stock Claude image | sbx upgrades |
| **Template** (`dev-loop-sbx:vN`) | our packages and settings | `npm run sbx:template:build` |
| Kit (`keystone-bedrock-kit`) | Bedrock network rule and login | never by us; applied on top at each create |

Your repos are not in the template: dev-loop and the target repo are
mounted live from your Mac.

## The recipe: `sandbox/sbx/template.sh`

Everything installed into a template is in that one script, which runs
inside the build sandbox. To add a package, add a line under
`# --- packages`, then rebuild.

## Rebuild (any change)

```
npm run sbx:template:build -- --tag=v3
```

1. Creates a build sandbox from the kit, with dev-loop mounted at its real
   path. The target repo is not mounted, so its real `.envrc` never
   enters a template.
2. Runs `template.sh` inside it, with the node major from the shell you
   run it in (override with `--node=26`).
3. Stops the sandbox, saves `dev-loop-sbx:v3`, and removes the build
   sandbox, even when a step fails.

It refuses a tag that already exists, so the old one stays for rollback.

Then:

1. Set `"template": "docker.io/library/dev-loop-sbx:v3"` in the project's
   `sandbox.sbx` block.
2. Run `npm run sbx:preflight && npm run sbx:smoke`.

If a host is blocked during the build (a new apt source, for example), the
build fails and says so. Review the host with `npm run sbx:status`, allow it
yourself (`sbx policy allow network <host>`), and rerun.

## One image per Node major

The preflight checks the image's Node against the **project's** major (its
`targetRepo.local.node.versionFile`, e.g. catalog's `app/.nvmrc` = 26), or
the host's when the project names none. A project on a different major gets
its own image and its own `sandbox.sbx.template`:

```
npm run sbx:template:build -- --tag=v2-node26 --node=26
```

and `"template": "docker.io/library/dev-loop-sbx:v2-node26"` in that
project's config. Projects on the host's major share `dev-loop-sbx:v2`.

## When to rebuild

| Trigger | How you find out |
|---|---|
| Add a tool or package | you decide; edit `template.sh` |
| The project moves to a new node major | preflight: "sandbox image has no node N", with the build command. Build with `--tag=v2-nodeN --node=N` (see "One image per Node major") |

## Roll back

Point `template` at the previous tag. Delete old tags once a newer one has
done a real run: `sbx template rm docker.io/library/dev-loop-sbx:v1`.

## Gotchas from the first builds

- Inside the sandbox `~` is `/home/agent`, not your home folder. Mounted
  repos are at their full Mac path.
- The image has no pager: `git config --get-regexp` fails with "unable to
  execute pager" until `core.pager cat` is set (`template.sh` sets it).
- Don't use Debian's own `nodejs`: it is node 20.
- `sbx template save` stops a running sandbox first; the build does that
  for you.
- `deb.nodesource.com` must be allowed once:
  `sbx policy allow network deb.nodesource.com`.
- A fresh build sandbox may still be running its own `apt-get` at boot, which
  holds the apt lock (`Could not get lock /var/lib/apt/lists/lock`).
  `template.sh` waits for it (up to 5 minutes) before installing.
