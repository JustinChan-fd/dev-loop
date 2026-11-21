# Guide versioning + changelog (2026-11-20)

Status: built on `feat/guide-versioning`; merge pending user review.

## Why
The guide (`docs/guide/how-dev-loop-works.html`) changes often (14 commits in
four days) and gets linked from chats and tickets. Without a version, a reader
can't tell whether the page they saw is the page that's up now, and a change
can't be pointed at. The user asked for versioning with changelog notes on a
separate page, so entries can be referenced.

## What
- `DATA.guideVersion` (starts at `1.0.0`) and `DATA.loopVersion` (package.json
  version the page was checked against) next to `DATA.updated`.
- Footer: "Guide v1.0.0 · checked against dev-loop 2.2.0 · 2026-11-20 ·
  What's new". "What's new" links `changelog.html#v1-0-0`. The contents row
  also gets a "What's new" link.
- `docs/guide/changelog.html`: a separate page (same tokens, fonts, light and
  dark) listing each version, newest first, with an anchor `#v<major>-<minor>-<patch>`.
  Each item is plain language and can link the matching CHANGELOG.md section
  and spec on GitHub.
- One source: `docs/guide/guide-changes.js` sets `window.GUIDE_CHANGES`. Both
  pages load it with a plain `<script src>`; no build.
- v1.0.0 is a summary backfill of the 14 commits that touched `docs/guide/`.

## Bump rule
Patch: a wording fix. Minor: a new section, step or repo. Major: a restructure.
Every change to `docs/guide/` bumps the version and adds an entry, in the same
change. Written in CLAUDE.md ("The guide page"), the guide's header comment and
the head of `guide-changes.js`.

## Mechanical check (the pillar)
`test/guide/guide-version.test.ts` (in `npm test`): entries are well formed;
versions strictly decrease and dates never go up down the list;
`DATA.guideVersion` and `DATA.updated` equal the newest entry; `DATA.loopVersion`
equals package.json; both pages load `guide-changes.js` and link each other;
entry links are absolute https or in-guide.

## Publishing
`.github/workflows/guide-pages.yml` already copies all of `docs/guide/` to
Pages, so `changelog.html` and `guide-changes.js` publish with no workflow
change.

## Next
The claude:sbx change bumps the guide to v1.1.0 (pillar 06, "How we build
dev-loop").
