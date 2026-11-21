/*
  What changed on the guide page, newest first. One source for both pages:
  how-dev-loop-works.html (footer, "What's new") and changelog.html (the list).

  Every change to docs/guide/ bumps the version and adds an entry here, in the
  same change, and sets DATA.guideVersion and DATA.updated on the guide to match.
  test/guide/guide-version.test.ts fails if they drift.

  Bump rule:
    patch (1.0.x)  a wording fix
    minor (1.x.0)  a new section, step or repo
    major (x.0.0)  a restructure of the page

  Entry: { version, date, title, items: [{ text, date?, links?: [{ label, href }] }] }
  Links are absolute https URLs (CHANGELOG.md sections, specs on GitHub).
*/
(function () {
  var GH = "https://github.com/JustinChan-fd/dev-loop/blob/main/";
  var CL = GH + "CHANGELOG.md";
  var SPEC = GH + "docs/superpowers/specs/";

  window.GUIDE_CHANGES = [
    {
      version: "1.0.0",
      date: "2026-11-20",
      title: "First versioned guide",
      items: [
        { text: "The guide now has its own version and this page of what changed. The footer says which dev-loop version it was checked against.", date: "2026-11-20" },
        { text: "Bounce criteria v2: the research step says when a ticket bounces and when it is too large.", date: "2026-11-20",
          links: [{ label: "CHANGELOG (Unreleased)", href: CL + "#unreleased" }, { label: "spec", href: SPEC + "2026-11-20-bounce-criteria-v2-design.md" }] },
        { text: "catalog-ui-management runs on v2 and in the sbx sandbox. The steps show the app folder and the repo's own Node.", date: "2026-11-20",
          links: [{ label: "CHANGELOG 2.2.0", href: CL + "#220--2026-11-20" }, { label: "spec", href: SPEC + "2026-11-20-project-profiles-design.md" }] },
        { text: "Shorter step explanations, core ideas only. The double-check step says why it installs packages from nexus3.", date: "2026-11-18" },
        { text: "The Play button walks through What happens on a timer, in both views. View all lights every box and lists every step.", date: "2026-11-18" },
        { text: "Numbered sections with a contents row, pillar cards, simpler options whose details fold away, and a note above the diagram.", date: "2026-11-18" },
        { text: "The settings table gets a two-column legend, icon badges and a two-line yes/no answer. The diagram's coloured zones are back.", date: "2026-11-18" },
        { text: "The robot never sees a target repo's real .envrc, and the page shows where the fake one comes from.", date: "2026-11-17",
          links: [{ label: "spec", href: SPEC + "2026-11-17-robot-fake-env-design.md" }] },
        { text: "The interactive guide page is born: repo, job, sandbox and mode chips, a step-through diagram, and where settings and secrets live.", date: "2026-11-17" },
      ],
    },
  ];
})();
