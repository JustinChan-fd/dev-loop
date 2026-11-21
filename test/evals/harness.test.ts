// The eval harness, verified without any outward action (Ruling 49):
// - pipeline.eval.config.json loads via the real loader and passes the
//   preflight guard;
// - `DRY_RUN=1 bash evals/run.sh clean` echoes every outward command as a
//   `DRY:` line and never runs one: a fake PATH dir comes first with
//   gh/claude/curl/npm stubs that record any call and exit 99;
// - run.sh refuses no args and an unknown scenario;
// - reset.sh closes nothing without --write;
// - no evals/*.sh line calls gh/curl/npm/claude except through `outward`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { loadConfig } from "../../src/core/config.ts";
import { checkEvalConfig, SANDBOX_REPO } from "../../evals/config-guard.mjs";
import { summarize } from "../../evals/report.mjs";
import { closeLabelUpdate, createIssueBody, EVAL_EPIC, jiraErrorDetail, STORY_POINTS_FIELD, EVAL_STORY_POINTS, waitSearchable } from "../../evals/jira.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const rel = (p: string) => relative(ROOT, p);
const EVAL_CONFIG = join(ROOT, "pipeline.eval.config.json");
const STUBS = ["gh", "claude", "curl", "npm"] as const;

/** An env override of `undefined` means "unset this variable". */
function withoutUndefined(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
}

describe("pipeline.eval.config.json", () => {
  it("loads via the real loader and passes the preflight guard", async () => {
    const config = await loadConfig(EVAL_CONFIG);
    expect(checkEvalConfig(config, "2.0.0")).toEqual([]);
  });

  it("points at the sandbox, polls only eval tickets, and has the lower ceilings", async () => {
    const c = await loadConfig(EVAL_CONFIG);
    expect(SANDBOX_REPO).toBe("JustinChan-fd/dev-loop-eval-sandbox");
    expect(c.github.repo).toBe(SANDBOX_REPO);
    expect(c.targetRepo.url).toContain(SANDBOX_REPO);
    expect(c.targetRepo.path).toBeUndefined();
    for (const role of ["research", "dev"] as const) {
      expect(c.roles[role].pollJql).toContain('AND labels = "dev-loop-eval"');
      expect(c.roles[role].pollJql).not.toContain('!= "dev-loop-eval"');
    }
    expect(c.roles.research.ceilings.maxCostPerRunUsd).toBe(15);
    expect(c.roles.dev.ceilings.maxCostPerRunUsd).toBe(10);
    expect(c.ceilings.maxRunsPerDay).toBe(10);
  });

  it("the guard rejects a non-sandbox repo and a JQL without the eval label", async () => {
    const good = await loadConfig(EVAL_CONFIG);
    const otherRepo = structuredClone(good);
    otherRepo.github.repo = "fandango/webtarsthree";
    expect(checkEvalConfig(otherRepo, "2.0.0").join("\n")).toMatch(/github\.repo/);
    const noLabel = structuredClone(good);
    noLabel.roles.dev.pollJql = noLabel.roles.dev.pollJql.replace(' AND labels = "dev-loop-eval"', "");
    expect(checkEvalConfig(noLabel, "2.0.0").join("\n")).toMatch(/roles\.dev\.pollJql/);
    const excluded = structuredClone(good);
    excluded.roles.research.pollJql = excluded.roles.research.pollJql.replace('labels = "dev-loop-eval"', 'labels != "dev-loop-eval"');
    expect(checkEvalConfig(excluded, "2.0.0").join("\n")).toMatch(/roles\.research\.pollJql/);
    const otherTarget = structuredClone(good);
    otherTarget.targetRepo.url = "git@github.com:fandango/webtarsthree.git";
    expect(checkEvalConfig(otherTarget, "2.0.0").join("\n")).toMatch(/targetRepo\.url/);
  });

  it("the webtarsthree config fails the guard", async () => {
    const w = await loadConfig(join(ROOT, "pipeline.webtarsthree.config.json"));
    expect(checkEvalConfig(w, "2.0.0").length).toBeGreaterThan(0);
  });
});

describe("evals harness, dry run", () => {
  let tmp: string;
  let stubDir: string;
  let stateDir: string;
  let markers: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "eval-dry-"));
    stubDir = join(tmp, "bin");
    stateDir = join(tmp, "state");
    markers = join(tmp, "called");
    mkdirSync(stubDir);
    mkdirSync(markers);
    for (const name of STUBS) {
      const p = join(stubDir, name);
      writeFileSync(p, `#!/bin/sh\necho "$0 $*" > "${markers}/${name}"\nexit 99\n`);
      chmodSync(p, 0o755);
    }
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const run = (script: string, args: string[], env: Record<string, string | undefined> = {}) =>
    spawnSync("bash", [join(ROOT, "evals", script), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: withoutUndefined({
        PATH: `${stubDir}:${process.env.PATH ?? ""}`,
        HOME: process.env.HOME ?? tmp,
        DRY_RUN: "1",
        EVAL_STATE_DIR: stateDir,
        // A node call that slipped past `outward` would load this missing
        // env file and exit non-zero, never the real .env (and no Jira
        // credentials are in this env at all).
        DEVLOOP_ENV_FILE: join(tmp, "no-such.env"),
        ...env,
      }),
    });

  const stubsCalled = () => readdirSync(markers);
  const lines = (r: { stdout: string; stderr: string }) => `${r.stdout}${r.stderr}`.split("\n").filter((l) => l.trim() !== "");

  it("run.sh clean exits 0, echoes only DRY: lines for outward commands, and calls no stub", () => {
    const r = run("run.sh", ["clean"]);
    expect(r.status, r.stderr).toBe(0);
    expect(stubsCalled()).toEqual([]);
    const all = lines(r);
    const bad = all.filter((l) => !l.startsWith("DRY: ") && !l.startsWith("[eval] "));
    expect(bad).toEqual([]);
    const dry = all.filter((l) => l.startsWith("DRY: "));
    expect(dry.some((l) => l.includes("npm run loop -- --config=pipeline.eval.config.json") && l.includes("--once"))).toBe(true);
    expect(dry.some((l) => l.includes("evals/jira.mjs create"))).toBe(true);
    expect(dry.some((l) => l.includes("gh auth status"))).toBe(true);
    expect(dry.some((l) => l.includes("evals/check-clean.mjs"))).toBe(true);
    expect(dry.some((l) => /evals\/jira\.mjs create --summary=.* --description-file=/.test(l))).toBe(true);
    expect(dry.some((l) => /evals\/check-clean\.mjs --config=pipeline\.eval\.config\.json --keys=DRY-1/.test(l))).toBe(true);
    // Lines that name an outward tool are only ever DRY: lines.
    const outwardNamed = all.filter((l) => /(^|\s)(gh|curl|claude|npm run loop)(\s|$)|jira\.mjs/.test(l));
    expect(outwardNamed.every((l) => l.startsWith("DRY: "))).toBe(true);
  });

  it("run.sh --fixture refuses an unrunnable fixture (no ticket.json yet), naming every problem, and calls no stub", () => {
    const r = run("run.sh", ["--fixture=mc-1718"]);
    expect(r.status).toBe(1);
    expect(stubsCalled()).toEqual([]);
    expect(r.stderr).toMatch(/ticket\.json: missing.*fixture:save/);
    expect(r.stderr).toMatch(/UNVERIFIED/);
    expect(r.stderr).not.toMatch(/DRY: gh auth status/);
  });

  it("run.sh --fixture dry-runs a runnable fixture: prints the plan, runs nothing, calls no stub", () => {
    const fx = join(tmp, "fixtures", "fx-dry");
    mkdirSync(fx, { recursive: true });
    writeFileSync(join(fx, "ticket.json"), JSON.stringify({ key: "FX-1", summary: "s", issue_type: "Story", description: "d", reviewed: true }));
    writeFileSync(join(fx, "repo.json"), JSON.stringify({ project: "webtarsthree", sha: "abcdef12", verified: true }));
    writeFileSync(join(fx, "expect.json"), JSON.stringify({ outcomes: ["ready"] }));
    const r = run("run.sh", ["--fixture=fx-dry", "--runs=2"], { EVAL_FIXTURES_DIR: join(tmp, "fixtures") });
    expect(r.status, r.stderr).toBe(0);
    expect(stubsCalled()).toEqual([]);
    expect(r.stdout).toMatch(/fixture fx-dry: ticket FX-1/);
    expect(r.stdout).toMatch(/2 run\(s\)/);
    expect(r.stdout).toMatch(/nothing runs/);
    expect(existsSync(join(ROOT, ".pipeline", "v2", "fixtures", "fx-dry"))).toBe(false);
  });

  it("run.sh --fixture refuses live inside Claude Code before anything runs", () => {
    const r = run("run.sh", ["--fixture=mc-1718"], { DRY_RUN: "0", CLAUDECODE: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/CLAUDECODE/);
    expect(stubsCalled()).toEqual([]);
  });

  it("run.sh clean exports the eval keys and the sandbox GH_REPO, and records dry keys only in keys.dry", () => {
    const r = run("run.sh", ["clean"]);
    expect(r.status, r.stderr).toBe(0);
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toContain("[eval] DEVLOOP_EVAL_KEYS=DRY-1");
    expect(out).toContain("[eval] GH_REPO=JustinChan-fd/dev-loop-eval-sandbox");
    expect(existsSync(join(stateDir, "keys"))).toBe(false);
    expect(readFileSync(join(stateDir, "keys.dry"), "utf8").trim().split("\n")).toEqual(["DRY-1"]);
  });

  it("run.sh --all dry-runs the five root-layout scenarios without calling a stub", () => {
    const r = run("run.sh", ["--all"], { EVAL_APP_CHECKOUT: join(tmp, "checkout") });
    expect(r.status, r.stderr).toBe(0);
    expect(stubsCalled()).toEqual([]);
    for (const name of ["clean", "ambiguous", "dev-bounce", "blocked", "queue"]) {
      expect(r.stdout + r.stderr).toContain(`evals/check-${name}.mjs`);
    }
    // queue works two tickets: two loop iterations.
    const out = r.stdout + r.stderr;
    const queueLoops = out
      .slice(out.indexOf("[eval] scenario queue\n"), out.indexOf("[eval] scenario clean-app\n"))
      .split("\n")
      .filter((l) => l.includes("npm run loop"));
    expect(queueLoops.length).toBe(2);
  });

  it("DRY_RUN unset or empty means dry: run.sh clean runs no stub", () => {
    for (const value of [undefined, ""]) {
      const r = run("run.sh", ["clean"], { DRY_RUN: value });
      expect(r.status, `DRY_RUN=${JSON.stringify(value)}: ${r.stderr}`).toBe(0);
      expect(r.stdout + r.stderr).toContain("DRY: ");
      expect(r.stdout + r.stderr).toContain("mode: dry");
      expect(stubsCalled()).toEqual([]);
    }
  });

  it("DRY_RUN values other than 0, 1 or empty are refused before anything runs", () => {
    for (const value of ["true", "yes", "false", "00", " 0", "1 "]) {
      for (const script of ["run.sh", "reset.sh", "preflight.sh"]) {
        const r = run(script, script === "run.sh" ? ["clean"] : [], { DRY_RUN: value });
        expect(r.status, `${script} DRY_RUN=${JSON.stringify(value)}`).not.toBe(0);
        expect(r.stdout + r.stderr).toMatch(/DRY_RUN/);
        expect(r.stdout + r.stderr).not.toContain("DRY: ");
      }
    }
    expect(stubsCalled()).toEqual([]);
  });

  it("run.sh's usage names DRY_RUN=0 as the live mode", () => {
    const r = run("run.sh", []);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("DRY_RUN=0");
  });

  it("run.sh with no args, an unknown name, or two names exits non-zero", () => {
    for (const args of [[], ["nope"], ["clean", "queue"]]) {
      const r = run("run.sh", args);
      expect(r.status, args.join(" ")).not.toBe(0);
    }
    expect(stubsCalled()).toEqual([]);
  });

  it("run.sh refuses to run for real when the config fails the guard", () => {
    const badConfig = join(tmp, "bad.config.json");
    const cfg = JSON.parse(readFileSync(EVAL_CONFIG, "utf8"));
    cfg.github.repo = "fandango/webtarsthree";
    writeFileSync(badConfig, JSON.stringify(cfg));
    const r = run("run.sh", ["clean"], { EVAL_CONFIG: badConfig });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).not.toContain("npm run loop");
    expect(stubsCalled()).toEqual([]);
  });

  it("run.sh refuses LIVE mode (DRY_RUN=0) when CLAUDECODE is set, before anything runs (M5)", () => {
    for (const value of ["1", ""]) {
      const r = run("run.sh", ["clean"], { DRY_RUN: "0", CLAUDECODE: value });
      expect(r.status, `CLAUDECODE=${JSON.stringify(value)}`).not.toBe(0);
      const out = r.stdout + r.stderr;
      expect(out).toMatch(/CLAUDECODE/);
      expect(out).toMatch(/a human must run live evals from their own shell/);
      expect(out).not.toContain("DRY: ");
      expect(out).not.toContain("scenario clean");
      expect(existsSync(stateDir)).toBe(false);
    }
    expect(stubsCalled()).toEqual([]);
  });

  it("run.sh dry mode still works when CLAUDECODE is set (M5)", () => {
    const r = run("run.sh", ["clean"], { CLAUDECODE: "1" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toContain("mode: dry");
    expect(r.stdout + r.stderr).toContain("DRY: ");
    expect(stubsCalled()).toEqual([]);
  });

  it("reset.sh without --write lists eligible keys and closes nothing", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "keys"), "TARS-9001\nTARS-9002\n");
    const r = run("reset.sh", []);
    expect(r.status, r.stderr).toBe(0);
    expect(stubsCalled()).toEqual([]);
    const out = r.stdout + r.stderr;
    expect(out).toContain("TARS-9001");
    expect(out).not.toMatch(/DRY: .*(close|PATCH)/);
    expect(out).toContain("--write");
  });

  it("reset.sh --write (dry) only echoes the closes, behind the sandbox guard", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "keys"), "TARS-9001\n");
    const r = run("reset.sh", ["--write"]);
    expect(r.status, r.stderr).toBe(0);
    expect(stubsCalled()).toEqual([]);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/DRY: .*jira\.mjs close TARS-9001/);
    expect(out).toMatch(/DRY: .*repos\/JustinChan-fd\/dev-loop-eval-sandbox\/pulls/);
  });

  it("reset.sh --write (dry) also lists the sandbox's open Issues and branches to remove", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "keys"), "TARS-9001\n");
    const r = run("reset.sh", ["--write"]);
    expect(r.status, r.stderr).toBe(0);
    const out = r.stdout + r.stderr;
    // Mirror Issues and pushed branches are left by every run (TARS-1642's Issue #2 and branch).
    expect(out).toMatch(/DRY: .*repos\/JustinChan-fd\/dev-loop-eval-sandbox\/issues\?state=open/);
    expect(out).toMatch(/DRY: .*repos\/JustinChan-fd\/dev-loop-eval-sandbox\/branches/);
    expect(stubsCalled()).toEqual([]);
  });

  it("reset.sh skips keys that are not well-formed", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "keys"), "TARS-9001\n$(rm -rf x)\n");
    const r = run("reset.sh", ["--write"]);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("rm -rf");
  });

  // The app-layout scenario (project profiles): its checkout lives outside dev-loop's folder.
  const appEnv = () => ({ EVAL_APP_CHECKOUT: join(tmp, "checkout") });

  it("run.sh clean-app dry-runs on the rendered app config, and plants the canary only through outward", () => {
    const r = run("run.sh", ["clean-app"], appEnv());
    expect(r.status, r.stderr).toBe(0);
    expect(stubsCalled()).toEqual([]);
    const all = lines(r);
    expect(all.filter((l) => !l.startsWith("DRY: ") && !l.startsWith("[eval] "))).toEqual([]);
    const cfg = join(stateDir, "pipeline.eval-app.config.json");
    const loop = all.find((l) => l.startsWith("DRY: ") && l.includes("npm run loop"));
    expect(loop).toContain(`--config=${cfg}`);
    expect(all.some((l) => l.startsWith("DRY: ") && l.includes("evals/check-clean-app.mjs") && l.includes(`--canary-file=${join(stateDir, "canary")}`))).toBe(true);
    expect(all.some((l) => l.startsWith("DRY: ") && l.includes("app/.env.local"))).toBe(true);
    // A dry run writes no canary anywhere.
    expect(existsSync(join(tmp, "checkout", "app", ".env.local"))).toBe(false);
    expect(existsSync(join(stateDir, "canary"))).toBe(false);
  });

  it("run.sh empties a scenario's loop log before its run, so the grader never reads an old startup line", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "loop-clean.log"), "robot env: 3 fake setting(s) from app/.env.example\n");
    const r = run("run.sh", ["clean"]);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(stateDir, "loop-clean.log"), "utf8")).toBe("");
  });

  it("EVAL_SANDBOX=sbx adds --sandbox=sbx to the loop line; none adds nothing", () => {
    const sbx = run("run.sh", ["clean"], { EVAL_SANDBOX: "sbx" });
    expect(sbx.status, sbx.stderr).toBe(0);
    expect(lines(sbx).find((l) => l.includes("npm run loop"))).toContain("--sandbox=sbx");
    const none = run("run.sh", ["clean"], { EVAL_SANDBOX: "none" });
    expect(none.status, none.stderr).toBe(0);
    expect(lines(none).find((l) => l.includes("npm run loop"))).not.toContain("--sandbox");
  });

  it("EVAL_SANDBOX=docker is refused before anything runs", () => {
    const r = run("run.sh", ["clean"], { EVAL_SANDBOX: "docker" });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/EVAL_SANDBOX/);
    expect(r.stdout + r.stderr).not.toContain("DRY: ");
    expect(stubsCalled()).toEqual([]);
  });

  it("run.sh --all dry-runs six scenarios", () => {
    const r = run("run.sh", ["--all"], appEnv());
    expect(r.status, r.stderr).toBe(0);
    const graders = new Set([...(r.stdout + r.stderr).matchAll(/evals\/check-([\w-]+)\.mjs/g)].map((m) => m[1]));
    expect([...graders].sort()).toEqual(["ambiguous", "blocked", "clean", "clean-app", "dev-bounce", "queue"]);
  });

  it("seed-app.sh dry echoes a push only to the sandbox repo, and refuses another repo", () => {
    const r = run("seed-app.sh", [], appEnv());
    expect(r.status, r.stderr).toBe(0);
    expect(stubsCalled()).toEqual([]);
    const all = lines(r);
    expect(all.filter((l) => !l.startsWith("DRY: ") && !l.startsWith("[eval] "))).toEqual([]);
    expect(all.some((l) => /^DRY: git .* push origin/.test(l))).toBe(true);
    expect(all.some((l) => l.startsWith("DRY: ") && l.includes("JustinChan-fd/dev-loop-eval-sandbox"))).toBe(true);
    const other = run("seed-app.sh", [], { ...appEnv(), EVAL_REPO: "other/repo" });
    expect(other.status).not.toBe(0);
    expect(other.stdout + other.stderr).not.toContain("DRY: ");
  });

  it("reset.sh --write (dry) lists the canary files to remove", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "keys"), "TARS-9001\n");
    const r = run("reset.sh", ["--write"], appEnv());
    expect(r.status, r.stderr).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/DRY: rm -f .*checkout\/app\/\.env\.local/);
    expect(out).toMatch(/DRY: rm -f .*checkout\/\.envrc/);
  });

  it("the rendered eval-app config loads through the real loader and passes the guard", async () => {
    const out = join(tmp, "eval-app.json");
    const checkout = join(tmp, "checkout");
    const r = spawnSync("bash", ["-c", `. "${join(ROOT, "evals", "lib.sh")}"; render_app_config "$1" "$2"`, "_", checkout, out], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", DRY_RUN: "1" },
    });
    expect(r.status, r.stderr).toBe(0);
    const c = await loadConfig(out);
    expect(c.targetRepo.path).toBe(checkout);
    expect(c.targetRepo.local?.appDir).toBe("app");
    expect(checkEvalConfig(c, "2.0.0")).toEqual([]);
  });

  it("the guard refuses an app checkout inside dev-loop's folder, or one whose origin is not the sandbox", async () => {
    const out = join(tmp, "eval-app.json");
    spawnSync("bash", ["-c", `. "${join(ROOT, "evals", "lib.sh")}"; render_app_config "$1" "$2"`, "_", join(ROOT, ".pipeline", "x"), out], {
      env: { PATH: process.env.PATH ?? "", DRY_RUN: "1" },
    });
    expect(checkEvalConfig(await loadConfig(out), "2.0.0").join("\n")).toMatch(/targetRepo\.path/);
    const other = join(tmp, "other");
    mkdirSync(other);
    spawnSync("git", ["init", "-q", other]);
    spawnSync("git", ["-C", other, "remote", "add", "origin", "git@github.com:fandango/webtarsthree.git"]);
    spawnSync("bash", ["-c", `. "${join(ROOT, "evals", "lib.sh")}"; render_app_config "$1" "$2"`, "_", other, out], {
      env: { PATH: process.env.PATH ?? "", DRY_RUN: "1" },
    });
    expect(checkEvalConfig(await loadConfig(out), "2.0.0").join("\n")).toMatch(/origin/);
  });
});

describe("evals lib guards", () => {
  const lib = join(ROOT, "evals", "lib.sh");
  const sh = (body: string) =>
    spawnSync("bash", ["-c", `. "${lib}"; ${body}`], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", DRY_RUN: "1" } });

  it("assert_repo accepts only the sandbox", () => {
    expect(sh(`assert_repo JustinChan-fd/dev-loop-eval-sandbox && echo ok`).stdout).toContain("ok");
    expect(sh(`assert_repo fandango/webtarsthree && echo ok`).status).not.toBe(0);
  });

  it("eval_mode parses DRY_RUN: unset/empty/1 -> dry, 0 -> live, anything else refused", () => {
    const mode = (value: string | undefined) =>
      spawnSync("bash", ["-c", `. "${lib}" && eval_mode`], {
        encoding: "utf8",
        env: withoutUndefined({ PATH: process.env.PATH ?? "", DRY_RUN: value }),
      });
    expect(mode(undefined).stdout.trim()).toBe("dry");
    expect(mode("").stdout.trim()).toBe("dry");
    expect(mode("1").stdout.trim()).toBe("dry");
    // Parsed only: nothing outward is called here.
    expect(mode("0").stdout.trim()).toBe("live");
    for (const v of ["true", "TRUE", "no", "2", "0 "]) {
      const r = mode(v);
      expect(r.status, v).not.toBe(0);
      expect(r.stdout.trim(), v).not.toBe("live");
      expect(r.stderr, v).toMatch(/DRY_RUN/);
    }
  });

  it("outward refuses a DRY_RUN changed to a bad value after sourcing, and runs nothing", () => {
    const r = sh(`DRY_RUN=true outward echo LEAKED`);
    expect(r.stdout).not.toContain("LEAKED");
    expect(r.status).not.toBe(0);
  });

  it("api asserts the repo it actually calls (EVAL_REPO), before any outward command", () => {
    const ok = sh(`api GET pulls`);
    expect(ok.stderr).toContain("DRY: gh api -X GET repos/JustinChan-fd/dev-loop-eval-sandbox/pulls");
    const bad = spawnSync("bash", ["-c", `. "${lib}"; api GET pulls; echo after`], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", DRY_RUN: "1", EVAL_REPO: "fandango/webtarsthree" },
    });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).not.toContain("DRY: ");
    expect(bad.stdout).not.toContain("after");
  });

  it("assert_clone refuses a clone whose origin is not the sandbox", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-clone-"));
    try {
      spawnSync("git", ["init", "-q", dir]);
      spawnSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:fandango/webtarsthree.git"]);
      expect(sh(`assert_clone "${dir}" && echo ok`).status).not.toBe(0);
      spawnSync("git", ["-C", dir, "remote", "set-url", "origin", "git@github.com:JustinChan-fd/dev-loop-eval-sandbox.git"]);
      expect(sh(`assert_clone "${dir}" && echo ok`).stdout).toContain("ok");
      // A foreign push URL with the sandbox fetch URL is refused.
      spawnSync("git", ["-C", dir, "remote", "set-url", "--push", "origin", "git@github.com:fandango/webtarsthree.git"]);
      const pushBad = sh(`assert_clone "${dir}" && echo ok`);
      expect(pushBad.status).not.toBe(0);
      expect(pushBad.stderr).toMatch(/push/);
      spawnSync("git", ["-C", dir, "remote", "set-url", "--push", "origin", "https://github.com/JustinChan-fd/dev-loop-eval-sandbox.git"]);
      expect(sh(`assert_clone "${dir}" && echo ok`).stdout).toContain("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assert_clone still refuses a folder inside a repo (not its root)", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-sub-"));
    try {
      spawnSync("git", ["init", "-q", dir]);
      spawnSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:JustinChan-fd/dev-loop-eval-sandbox.git"]);
      mkdirSync(join(dir, "inner"));
      const r = sh(`assert_clone "${join(dir, "inner")}" && echo ok`);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("git root mismatch");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assert_clone accepts the same clone reached through a differently-cased path (case-insensitive macOS)", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-case-"));
    try {
      spawnSync("git", ["init", "-q", dir]);
      spawnSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:JustinChan-fd/dev-loop-eval-sandbox.git"]);
      const upper = join(dirname(dir), basename(dir).toUpperCase());
      if (!existsSync(upper)) return; // case-sensitive filesystem: nothing to check
      const r = sh(`assert_clone "${upper}" && echo ok`);
      expect(r.stderr).not.toContain("git root mismatch");
      expect(r.stdout).toContain("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("outward echoes in dry mode and runs otherwise", () => {
    expect(sh(`outward echo hi`).stderr).toContain("DRY: echo hi");
    expect(sh(`DRY_RUN=0 outward echo hi`).stdout).toBe("hi\n");
  });

  it("run_to kills a command past its wall-clock limit", () => {
    const r = spawnSync("bash", ["-c", `. "${lib}"; run_to 1 sleep 5`], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
  });

  describe("run_to kills the whole process tree (I2)", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "eval-run-to-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    /** Poll briefly: a killed grandchild can linger as a zombie until init reaps it. */
    const goneSoon = (pid: number) => {
      const end = Date.now() + 1500;
      while (alive(pid) && Date.now() < end) spawnSync("sleep", ["0.05"]);
      return !alive(pid);
    };
    // An npm-like wrapper: a shell that starts a long-lived grandchild and
    // waits on it, so a signal to the wrapper alone leaves the grandchild.
    const wrapper = (grandchild: string) => {
      const pidFile = join(dir, "grandchild.pid");
      const w = join(dir, "npm-like.sh");
      writeFileSync(w, `#!/bin/sh\n${grandchild} &\necho $! > "${pidFile}"\nwait\n`);
      chmodSync(w, 0o755);
      return { w, pidFile };
    };

    it("a grandchild started through an npm-like wrapper is gone after run_to returns", () => {
      const { w, pidFile } = wrapper("sleep 30");
      const t0 = Date.now();
      const r = spawnSync("bash", ["-c", `. "${lib}"; RUN_TO_GRACE_S=1 run_to 1 "${w}"`], { encoding: "utf8", timeout: 10_000 });
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(r.status).not.toBe(0);
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(goneSoon(pid)).toBe(true);
    });

    it("a grandchild that ignores SIGTERM is SIGKILLed after the grace", () => {
      const { w, pidFile } = wrapper(`sh -c 'trap "" TERM; sleep 30'`);
      const t0 = Date.now();
      const r = spawnSync("bash", ["-c", `. "${lib}"; RUN_TO_GRACE_S=1 run_to 1 "${w}"`], { encoding: "utf8", timeout: 10_000 });
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(r.status).not.toBe(0);
      expect(Date.now() - t0).toBeLessThan(6_000);
      expect(goneSoon(pid)).toBe(true);
    });

    it("a command that finishes in time keeps its exit status and output", () => {
      expect(sh(`run_to 5 sh -c 'echo hi; exit 3'`)).toMatchObject({ status: 3, stdout: "hi\n" });
      expect(sh(`run_to 5 true`).status).toBe(0);
    });
  });

  it("no evals/*.sh line calls gh/curl/npm/claude except through outward", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".sh")) files.push(p);
      }
    };
    walk(join(ROOT, "evals"));
    expect(files.length).toBeGreaterThanOrEqual(11);
    // Outside heredoc bodies, comments and quoted strings, any gh/curl/npm/
    // claude word, and any node call of jira.mjs or a check-*.mjs, must come
    // after `outward` on its line (lib.sh's `api`/`jira` wrap it themselves).
    const OUTWARD_WORD = /(^|[^\w.$/-])(gh|curl|npm|claude)(?![\w.-])|node[^\n]*(jira\.mjs|check-[\w-]+\.mjs)/;
    const hits: string[] = [];
    for (const f of files) {
      let heredocEnd: string | null = null;
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (heredocEnd !== null) {
            if (line.trim() === heredocEnd) heredocEnd = null;
            return;
          }
          const start = /<<-?\s*'?(\w+)'?/.exec(line);
          if (start) heredocEnd = start[1];
          const code = line
            .replace(/^\s*#.*$/, "")
            .replace(/\s#.*$/, "")
            .replace(/'[^']*'/g, "''")
            .replace(/"(?:[^"\\]|\\.)*"/g, '""');
          const m = OUTWARD_WORD.exec(code);
          if (m && !code.slice(0, m.index).includes("outward")) hits.push(`${rel(f)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
    // The matcher is not a no-op.
    expect(OUTWARD_WORD.test("run_to 10 npm run loop")).toBe(true);
    expect(OUTWARD_WORD.test("x && gh pr close 1")).toBe(true);
    expect(OUTWARD_WORD.test("node evals/jira.mjs close K")).toBe(true);
    expect(OUTWARD_WORD.test('log "$GH_REPO"'.replace(/"(?:[^"\\]|\\.)*"/g, '""'))).toBe(false);
  });
});

describe("evals/report.mjs", () => {
  it("summarizes outcome, phases, cost and minutes per scenario", () => {
    const records = [
      {
        ticket: "TARS-1",
        session: "s1",
        loop_version: "2.0.0",
        started: "2026-11-12T10:00:00.000Z",
        ended: "2026-11-12T10:30:00.000Z",
        outcome: "landed",
        phases: [
          { role: "research", outcome: "landed", cost_usd: 4.5 },
          { role: "dev", outcome: "landed", cost_usd: 6 },
        ],
      },
      { ticket: "TARS-2", session: "s1", loop_version: "2.0.0", started: "x", ended: "y", outcome: "skipped-blocked", phases: [] },
    ];
    const rows = summarize(records, [
      { scenario: "clean", keys: ["TARS-1"] },
      { scenario: "blocked", keys: ["TARS-2"] },
    ]);
    expect(rows).toEqual([
      { scenario: "clean", ticket: "TARS-1", outcome: "landed", phases: "research:landed dev:landed", cost_usd: 10.5, minutes: 30 },
      { scenario: "blocked", ticket: "TARS-2", outcome: "skipped-blocked", phases: "", cost_usd: 0, minutes: null },
    ]);
  });
});

describe("evals/jira.mjs create request body", () => {
  it("sets Story Points (so the To Do -> In Progress claim is not refused), labels and the TARS project", () => {
    expect(STORY_POINTS_FIELD).toBe("customfield_10002");
    expect(EVAL_STORY_POINTS).toBe(1);
    const body = createIssueBody("[dev-loop-eval] x", "line one\n\nline two", true);
    expect(body.fields.customfield_10002).toBe(1);
    expect(body.fields.project).toEqual({ key: "TARS" });
    expect(body.fields.summary).toBe("[dev-loop-eval] x");
    expect(body.fields.labels).toEqual(["repo:dev-loop-eval", "dev-loop-eval", "pipeline:v2"]);
    expect(body.fields.description.content).toHaveLength(2);
    expect(body).not.toHaveProperty("transition");
    // TARS requires every Task to sit under an Epic ("Must be linked to an Epic using the Parent field").
    expect(EVAL_EPIC).toBe("TARS-1384");
    expect(body.fields.parent).toEqual({ key: "TARS-1384" });
  });

  it("omits the trigger label without --trigger, and refuses a summary without the prefix", () => {
    expect(createIssueBody("[dev-loop-eval] b", "d", false).fields.labels).toEqual(["repo:dev-loop-eval", "dev-loop-eval"]);
    expect(() => createIssueBody("no prefix", "d", false)).toThrow(/dev-loop-eval/);
  });
});

describe("evals/jira.mjs error detail", () => {
  it("a Jira error names Jira's own reasons (field errors and messages), redacted", () => {
    const body = JSON.stringify({ errorMessages: ["Bad thing"], errors: { customfield_10002: "Field 'customfield_10002' cannot be set.", summary: "for alice@example.com" } });
    const msg = jiraErrorDetail(body);
    expect(msg).toContain("Bad thing");
    expect(msg).toContain("customfield_10002: Field 'customfield_10002' cannot be set.");
    expect(msg).not.toContain("alice@example.com");
  });

  it("a non-JSON or empty body gives its first 200 characters, or nothing", () => {
    expect(jiraErrorDetail("<html>gateway</html>")).toBe("<html>gateway</html>");
    expect(jiraErrorDetail("x".repeat(500))).toHaveLength(200);
    expect(jiraErrorDetail("")).toBe("");
  });
});

describe("evals/jira.mjs wait-searchable", () => {
  it("polls search for the keys until all are found, then resolves with the tries", async () => {
    const seen: string[] = [];
    let n = 0;
    const search = async (jql: string) => {
      seen.push(jql);
      return ++n < 3 ? ["TARS-1"] : ["TARS-1", "TARS-2"];
    };
    const sleeps: number[] = [];
    const tries = await waitSearchable(["TARS-1", "TARS-2"], { search, sleep: async (ms: number) => void sleeps.push(ms), timeoutMs: 60_000, stepMs: 5000 });
    expect(tries).toBe(3);
    expect(seen[0]).toBe("key in (TARS-1, TARS-2)");
    expect(sleeps).toEqual([5000, 5000]);
  });

  it("gives up after timeoutMs with a clear error naming the missing keys", async () => {
    let now = 0;
    await expect(
      waitSearchable(["TARS-9"], { search: async () => [], sleep: async (ms: number) => void (now += ms), now: () => now, timeoutMs: 20_000, stepMs: 5000 }),
    ).rejects.toThrow("Jira search still does not find TARS-9 after 20s (new tickets take ~30s to be searchable)");
  });

  it("refuses a non-key before any search", async () => {
    await expect(waitSearchable(["x) OR 1=1"], { search: async () => [], sleep: async () => {} })).rejects.toThrow(/not a ticket key/);
  });
});

describe("evals/jira.mjs close strips the pipeline labels", () => {
  it("the label update removes every pipeline:* label and keeps the rest", () => {
    expect(closeLabelUpdate(["dev-loop-eval", "pipeline:v2:dev", "repo:dev-loop-eval", "pipeline:v2"])).toEqual({
      update: { labels: [{ remove: "pipeline:v2:dev" }, { remove: "pipeline:v2" }] },
    });
    expect(closeLabelUpdate(["dev-loop-eval", "repo:dev-loop-eval"])).toBeNull();
  });
});
