import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseNodeMajor,
  resolveHostNodeBin,
  resolveProjectProfile,
  projectJson,
  ProfileError,
  type ProfileDeps,
} from "../../src/core/project-profile.ts";
import { makeV2Config } from "../fixtures/config.ts";

const CATALOG_LOCAL = {
  appDir: "app",
  node: { versionFile: "app/.nvmrc" },
  envTemplate: { path: "app/.env.example", format: "dotenv" as const },
  realEnvFiles: ["app/.env.local"],
  robotEnv: {},
  devCommand: "npm run dev",
  devUrl: "http://localhost:3000",
};

const gitRepo = (): string => {
  const d = mkdtempSync(join(tmpdir(), "profile-"));
  mkdirSync(join(d, ".git"));
  return d;
};

function deps(over: Partial<ProfileDeps> = {}): ProfileDeps & { gitCalls: Array<[string[], string]> } {
  const gitCalls: Array<[string[], string]> = [];
  return {
    gitCalls,
    git: async (args, cwd) => {
      gitCalls.push([args, cwd]);
      return "26\n";
    },
    nvmDir: "/h/.nvm",
    readdir: () => ["v24.16.0", "v26.1.0", "v26.7.0"],
    hostNodeMajor: 24,
    ...over,
  };
}

describe("parseNodeMajor", () => {
  it.each([
    ["26", 26],
    ["26\n", 26],
    ["v26", 26],
    ["26.7.0", 26],
    [" v24.16.0 \r\n", 24],
  ])("%j gives %d", (text, want) => {
    expect(parseNodeMajor(text, "app/.nvmrc")).toBe(want);
  });

  it.each(["lts/iron", "", "node", "latest"])("%j throws, naming the file", (text) => {
    expect(() => parseNodeMajor(text, "app/.nvmrc")).toThrow(ProfileError);
    expect(() => parseNodeMajor(text, "app/.nvmrc")).toThrow(/app\/\.nvmrc/);
    expect(() => parseNodeMajor(text, "app/.nvmrc")).toThrow(/a number/);
  });
});

describe("resolveHostNodeBin", () => {
  it("picks the newest patch, sorted as numbers", () => {
    const readdir = (p: string): string[] => {
      expect(p).toBe("/h/.nvm/versions/node");
      return ["v24.16.0", "v26.1.0", "v26.7.0", "v26.10.2"];
    };
    expect(resolveHostNodeBin(26, { nvmDir: "/h/.nvm", readdir }, "app/.nvmrc")).toBe("/h/.nvm/versions/node/v26.10.2/bin");
  });

  it("no install of that major is an error with the fix", () => {
    expect(() => resolveHostNodeBin(26, { nvmDir: "/h/.nvm", readdir: () => ["v24.16.0", "v260.1.0"] }, "app/.nvmrc")).toThrow(
      /node 26 \(from app\/\.nvmrc\) is not installed: run `nvm install 26`/,
    );
  });

  it("an unreadable versions dir is the same error", () => {
    const readdir = (): string[] => {
      throw new Error("ENOENT");
    };
    expect(() => resolveHostNodeBin(26, { nvmDir: "/h/.nvm", readdir }, "app/.nvmrc")).toThrow(ProfileError);
    expect(() => resolveHostNodeBin(26, { nvmDir: "/h/.nvm", readdir }, "app/.nvmrc")).toThrow(/nvm install 26/);
  });
});

describe("resolveProjectProfile", () => {
  it("no local block: today's defaults on host node, and git is never called", async () => {
    const d = deps();
    const p = await resolveProjectProfile(makeV2Config(), gitRepo(), d);
    expect(p).toEqual({
      appDir: ".",
      versionFile: null,
      envTemplate: { path: ".envrc.example", format: "export" },
      realEnvFiles: [],
      robotEnv: {},
      devCommand: "npm run dev",
      devUrl: "http://localhost:3000",
      nodeMajor: 24,
      nodeBin: null,
    });
    expect(d.gitCalls).toEqual([]);
  });

  it("catalog's block: the version file from origin/<default>, and the host install", async () => {
    const repo = gitRepo();
    const d = deps();
    const c = makeV2Config((c) => {
      c.targetRepo.local = CATALOG_LOCAL;
    });
    const p = await resolveProjectProfile(c, repo, d);
    expect(d.gitCalls).toEqual([[["show", "origin/main:app/.nvmrc"], repo]]);
    expect(p.nodeMajor).toBe(26);
    expect(p.nodeBin).toBe("/h/.nvm/versions/node/v26.7.0/bin");
    expect(p.appDir).toBe("app");
  });

  it("a version file missing on origin is a startup error", async () => {
    const d = deps({ git: async () => Promise.reject(new Error("fatal: path not in tree")) });
    const c = makeV2Config((c) => {
      c.targetRepo.local = CATALOG_LOCAL;
    });
    await expect(resolveProjectProfile(c, gitRepo(), d)).rejects.toThrow(/app\/\.nvmrc is not on origin\/main/);
  });

  it("a repo not cloned yet (no .git) with a version file is a startup error, never a silent host-node fallback", async () => {
    const d = deps();
    const c = makeV2Config((c) => {
      c.targetRepo.local = CATALOG_LOCAL;
    });
    const dir = mkdtempSync(join(tmpdir(), "nogit-"));
    await expect(resolveProjectProfile(c, dir, d)).rejects.toThrow(ProfileError);
    await expect(resolveProjectProfile(c, dir, d)).rejects.toThrow(/clone .* first.*app\/\.nvmrc/);
    expect(d.gitCalls).toEqual([]);
  });

  it("a repo not cloned yet with no version file is fine (host node, as today)", async () => {
    const p = await resolveProjectProfile(makeV2Config(), mkdtempSync(join(tmpdir(), "nogit-")), deps());
    expect(p.nodeMajor).toBe(24);
  });
});

describe("projectJson", () => {
  it("has exactly the four keys the skills read", async () => {
    const c = makeV2Config((c) => {
      c.targetRepo.local = CATALOG_LOCAL;
    });
    const p = await resolveProjectProfile(c, gitRepo(), deps());
    expect(projectJson(p)).toEqual({ appDir: "app", nodeMajor: 26, devCommand: "npm run dev", devUrl: "http://localhost:3000" });
  });
});
