import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileDenyPaths, rootEnvFiles } from "../../src/core/env-files.ts";

describe("profileDenyPaths", () => {
  let r: string;
  afterEach(() => rmSync(r, { recursive: true, force: true }));

  it("root env files, the app folder's env files, and the profile's realEnvFiles (present or not), sorted", () => {
    r = mkdtempSync(join(tmpdir(), "deny-"));
    mkdirSync(join(r, "app"));
    for (const f of [".envrc", "app/.env.local", "app/.env.example", "app/.env.test"]) writeFileSync(join(r, f), "X=fake\n");
    expect(profileDenyPaths(r, { appDir: "app", realEnvFiles: ["app/.env.local", "app/.env.staging"] })).toEqual([
      join(r, ".envrc"),
      join(r, "app/.env.local"),
      join(r, "app/.env.staging"),
      join(r, "app/.env.test"),
    ]);
  });

  it("the default profile is today's root list", () => {
    r = mkdtempSync(join(tmpdir(), "deny-"));
    for (const f of [".envrc", ".env", ".envrc.example"]) writeFileSync(join(r, f), "X=fake\n");
    expect(profileDenyPaths(r, { appDir: ".", realEnvFiles: [] })).toEqual(rootEnvFiles(r).map((f) => join(r, f)));
  });
});
