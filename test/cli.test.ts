import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../src/cli";
import { ExitCode } from "../src/utils/errors";
import { createHarness } from "./helpers";

describe("cli/help and version", () => {
  it("prints help with no arguments", async () => {
    const h = await createHarness();
    try {
      expect(await main([], h.ctx)).toBe(ExitCode.Success);
      expect(h.output()).toContain("One encrypted vault for every project.");
      expect(h.output()).toContain("envvault docker compose up");
    } finally {
      await h.cleanup();
    }
  });

  it("prints the version", async () => {
    const h = await createHarness();
    try {
      expect(await main(["--version"], h.ctx)).toBe(ExitCode.Success);
      expect(h.output()).toMatch(/envvault \d+\.\d+\.\d+/);
    } finally {
      await h.cleanup();
    }
  });

  it("reports unknown commands with a usage exit code", async () => {
    const h = await createHarness();
    try {
      expect(await main(["bogus"], h.ctx)).toBe(ExitCode.Usage);
      expect(h.errors()).toContain("Unknown command: bogus");
    } finally {
      await h.cleanup();
    }
  });
});

describe("cli/errors", () => {
  it("explains that the vault is not initialized", async () => {
    const h = await createHarness();
    try {
      expect(await main(["list"], h.ctx)).toBe(ExitCode.Missing);
      expect(h.errors()).toContain("EnvVault is not initialized.");
      expect(h.errors()).toContain("envvault init");
    } finally {
      await h.cleanup();
    }
  });
});

describe("cli/five-minute flow", () => {
  it("supports the documented first-run experience end to end", async () => {
    const h = await createHarness();
    try {
      expect(await main(["init"], h.ctx)).toBe(ExitCode.Success);
      expect(await main(["project", "add", "demo", "--env", "dev"], h.ctx)).toBe(ExitCode.Success);
      expect(await main(["use", "demo/dev"], h.ctx)).toBe(ExitCode.Success);

      h.state.stdin = "postgres://demo";
      expect(await main(["set", "DATABASE_URL", "--stdin"], h.ctx)).toBe(ExitCode.Success);
      h.state.stdin = "api-key-value";
      expect(await main(["set", "API_KEY", "--stdin"], h.ctx)).toBe(ExitCode.Success);

      h.stdout.length = 0;
      expect(await main(["list"], h.ctx)).toBe(ExitCode.Success);
      expect(h.output()).toContain("demo / dev");
      expect(h.output()).toContain("DATABASE_URL");
      expect(h.output()).not.toContain("postgres://demo");

      const outFile = join(h.cwd, "check.txt");
      const script = [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(outFile)}, [Boolean(process.env.DATABASE_URL), Boolean(process.env.API_KEY)].join(","));`,
      ].join("");
      const code = await main(["run", "--", process.execPath, "-e", script], h.ctx);
      expect(code).toBe(ExitCode.Success);
      expect(await readFile(outFile, "utf8")).toBe("true,true");
    } finally {
      await h.cleanup();
    }
  });

  it("supports ENVVAULT_MASTER_PASSWORD for non-interactive automation", async () => {
    const h = await createHarness();
    try {
      h.ctx.env.ENVVAULT_MASTER_PASSWORD = "automation-password";
      expect(await main(["init"], h.ctx)).toBe(ExitCode.Success);
      expect(await main(["project", "add", "ci", "--env", "test"], h.ctx)).toBe(ExitCode.Success);
      expect(await main(["use", "ci/test"], h.ctx)).toBe(ExitCode.Success);
      h.stdout.length = 0;
      expect(await main(["list"], h.ctx)).toBe(ExitCode.Success);
      expect(h.output()).toContain("ci / test");
    } finally {
      await h.cleanup();
    }
  });
});
