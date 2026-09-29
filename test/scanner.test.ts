import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { extractEnvNames, scanProject } from "../src/env/scanner";
import { createHarness, writeProjectFile } from "./helpers";

describe("scanner/extractEnvNames", () => {
  it("finds JavaScript process.env references", () => {
    const source = [
      "const a = process.env.DATABASE_URL;",
      'const b = process.env["API_KEY"];',
      "const c = import.meta.env.PUBLIC_URL;",
    ].join("\n");
    const names = extractEnvNames(source, "src/app.ts").map((ref) => ref.name).sort();
    expect(names).toEqual(["API_KEY", "DATABASE_URL", "PUBLIC_URL"]);
  });

  it("records file and line numbers", () => {
    const source = ["// header", "const key = process.env.SECRET_KEY;"].join("\n");
    const [ref] = extractEnvNames(source, "src/config.ts");
    expect(ref).toEqual({ name: "SECRET_KEY", file: "src/config.ts", line: 2 });
  });

  it("finds Python references", () => {
    const source = ['import os', 'x = os.environ["SMTP_PASSWORD"]', 'y = os.getenv("TOKEN")'].join("\n");
    const names = extractEnvNames(source, "app.py").map((ref) => ref.name).sort();
    expect(names).toEqual(["SMTP_PASSWORD", "TOKEN"]);
  });

  it("ignores known system variables", () => {
    const source = 'process.env.NODE_ENV; process.env.PATH; process.env.REAL_VALUE;';
    expect(extractEnvNames(source, "a.ts").map((ref) => ref.name)).toEqual(["REAL_VALUE"]);
  });

  it("finds shell variables only in shell files", () => {
    expect(extractEnvNames("echo $MY_VAR ${OTHER}", "run.sh").map((ref) => ref.name).sort()).toEqual([
      "MY_VAR",
      "OTHER",
    ]);
    expect(extractEnvNames("const x = '$MY_VAR';", "a.ts")).toEqual([]);
  });

  it("reads names from .env files", () => {
    const names = extractEnvNames("A=1\n# c\nB=2", ".env.example").map((ref) => ref.name);
    expect(names).toEqual(["A", "B"]);
  });

  it("finds Dockerfile ARG and ENV names", () => {
    const source = ["FROM node:20", "ARG NPM_TOKEN", "ENV APP_ENV=production"].join("\n");
    const names = extractEnvNames(source, "Dockerfile").map((ref) => ref.name).sort();
    expect(names).toEqual(["APP_ENV", "NPM_TOKEN"]);
  });
});

describe("scanner/scanProject", () => {
  it("scans a project tree and skips ignored directories", async () => {
    const harness = await createHarness();
    try {
      await writeProjectFile(harness, "app.ts", "process.env.DATABASE_URL");
      await writeProjectFile(harness, ".env.example", "API_KEY=");
      const refs = await scanProject(harness.cwd);
      const names = refs.map((ref) => ref.name).sort();
      expect(names).toEqual(["API_KEY", "DATABASE_URL"]);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns an empty list for an empty directory", async () => {
    const harness = await createHarness();
    try {
      expect(await scanProject(join(harness.cwd))).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });
});
