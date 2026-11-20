import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { parseArgs, preflight } from "../../src/core/cli-args.ts";
import { loadConfig, ConfigError } from "../../src/core/config.ts";
import { makeV2Config } from "../fixtures/config.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

describe("parseArgs", () => {
  it("defaults: worker phase, no session, not once, not streaming", () => {
    expect(parseArgs(["--project=webtarsthree"])).toEqual({
      phase: "worker",
      project: "webtarsthree",
      configPath: undefined,
      session: undefined,
      once: false,
      stream: false,
      preflightOnly: false,
      noDashboard: false,
    });
  });

  it("--preflight-only is a bare boolean", () => {
    expect(parseArgs(["--project=p", "--preflight-only"]).preflightOnly).toBe(true);
  });

  it("reads every flag in --name=value form", () => {
    expect(parseArgs(["--stream", "--project=webtarsthree", "--session=dev-2", "--phase=dev", "--once"])).toEqual({
      phase: "dev",
      project: "webtarsthree",
      configPath: undefined,
      session: "dev-2",
      once: true,
      stream: true,
      preflightOnly: false,
      noDashboard: false,
    });
    expect(parseArgs(["--config=/tmp/x.json", "--phase=research"]).configPath).toBe("/tmp/x.json");
    expect(parseArgs(["--project=p", "--phase=worker"]).phase).toBe("worker");
  });

  it("rejects the old --name value form with the exact replacement", () => {
    expect(() => parseArgs(["--project", "webtarsthree"])).toThrow(/use --project=webtarsthree/);
    expect(() => parseArgs(["--project=p", "--phase", "dev"])).toThrow(/use --phase=dev/);
  });

  it("rejects --phase=foo, naming the allowed values", () => {
    expect(() => parseArgs(["--project=p", "--phase=foo"])).toThrow(/--phase=worker\|research\|dev.*"foo"/);
  });

  it("rejects a flag with no value", () => {
    expect(() => parseArgs(["--project"])).toThrow(/--project needs a value/);
    expect(() => parseArgs(["--project=p", "--session"])).toThrow(/--session needs a value/);
    expect(() => parseArgs(["--project=p", "--phase", "--once"])).toThrow(/--phase needs a value/);
  });

  it("requires exactly one of --project / --config", () => {
    expect(() => parseArgs([])).toThrow(/--project=<name>/);
    expect(() => parseArgs(["--project=p", "--config=c.json"])).toThrow(/not both/);
  });

  it("rejects unknown flags and stray arguments", () => {
    expect(() => parseArgs(["--project=p", "--onec"])).toThrow(/unknown argument "--onec"/);
    expect(() => parseArgs(["--project=p", "extra"])).toThrow(/unknown argument "extra"/);
  });

  it("has no way to pass session test seams", () => {
    expect(() => parseArgs(["--project=p", "--_hooks=x"])).toThrow(/unknown argument/);
    expect(Object.keys(parseArgs(["--project=p"]))).not.toContain("_hooks");
  });
});

describe("preflight", () => {
  it("worker mode refuses catalog-ui-public (v1 labels until cutover)", async () => {
    const pub = await loadConfig(resolve(REPO_ROOT, "pipeline.catalog-ui-public.config.json"));
    expect(() => preflight(pub, "worker", "2.0.0")).toThrow(ConfigError);
  });

  it("worker mode accepts catalog-ui-management (v2 labels since project profiles)", async () => {
    const mgmt = await loadConfig(resolve(REPO_ROOT, "pipeline.catalog-ui-management.config.json"));
    expect(preflight(mgmt, "worker", "2.0.0")).toEqual({ warnings: [] });
  });

  it("worker mode accepts webtarsthree with no warning", async () => {
    const w = await loadConfig(resolve(REPO_ROOT, "pipeline.webtarsthree.config.json"));
    expect(preflight(w, "worker", "2.0.0")).toEqual({ warnings: [] });
  });

  it("worker mode: a minor/patch difference passes silently, a major one refuses", () => {
    const c = makeV2Config();
    expect(preflight(c, "worker", "2.1.0")).toEqual({ warnings: [] });
    expect(() => preflight(c, "worker", "3.0.0")).toThrow(/major version mismatch/);
  });

  it("checks placeholders before the label guard (catalog-ui-public: placeholder error names its fields)", async () => {
    const pub = await loadConfig(resolve(REPO_ROOT, "pipeline.catalog-ui-public.config.json"));
    expect(() => preflight(pub, "worker", "2.0.0")).toThrow(/placeholder/);
  });

  it("--phase research|dev do not enforce the label guard", async () => {
    const mgmt = await loadConfig(resolve(REPO_ROOT, "pipeline.catalog-ui-management.config.json"));
    expect(preflight(mgmt, "research", "2.0.0")).toEqual({ warnings: [] });
    expect(preflight(mgmt, "dev", "2.0.0")).toEqual({ warnings: [] });
  });
});

describe("parseArgs: --sandbox", () => {
  it("reads --sandbox=<name>; absent is undefined", () => {
    expect(parseArgs(["--project=p", "--sandbox=none"]).sandbox).toBe("none");
    expect(parseArgs(["--project=p"]).sandbox).toBeUndefined();
  });

  it("refuses the space form with the replacement", () => {
    expect(() => parseArgs(["--project=p", "--sandbox", "none"])).toThrow("use --sandbox=none");
  });
});

describe("parseArgs: --no-dashboard", () => {
  it("is false by default and true when passed", () => {
    expect(parseArgs(["--project=p"]).noDashboard).toBe(false);
    expect(parseArgs(["--project=p", "--sandbox=sbx", "--no-dashboard"]).noDashboard).toBe(true);
  });
});
