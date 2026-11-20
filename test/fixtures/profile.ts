// Resolved project profiles for tests: today's defaults, and catalog's shape.

import type { ResolvedProfile } from "../../src/core/project-profile.ts";

export const DEFAULT_PROFILE: ResolvedProfile = {
  appDir: ".",
  versionFile: null,
  envTemplate: { path: ".envrc.example", format: "export" },
  realEnvFiles: [],
  robotEnv: {},
  devCommand: "npm run dev",
  devUrl: "http://localhost:3000",
  nodeMajor: 24,
  nodeBin: null,
};

export const APP_PROFILE: ResolvedProfile = {
  appDir: "app",
  versionFile: "app/.nvmrc",
  envTemplate: { path: "app/.env.example", format: "dotenv" },
  realEnvFiles: ["app/.env.local"],
  robotEnv: {},
  devCommand: "npm run dev",
  devUrl: "http://localhost:3000",
  nodeMajor: 26,
  nodeBin: "/h/.nvm/versions/node/v26.7.0/bin",
};
