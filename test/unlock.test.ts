import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listCommand } from "../src/commands/list";
import { setCommand } from "../src/commands/set";
import { unlockWithPasswordValue } from "../src/core/unlock";
import { ExitCode, VaultLockedError, WrongPasswordError } from "../src/utils/errors";
import { parseArgs } from "../src/utils/args";
import { createHarness, setupProject } from "./helpers";

describe("unlock/password sources", () => {
  it("reads the password from ENVVAULT_MASTER_PASSWORD_FILE", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { A: "1" });

      const file = join(h.cwd, "password.txt");
      await writeFile(file, `${h.state.password}\n`, "utf8");
      await chmod(file, 0o600);

      // No env password, no prompt, and a deliberately wrong prompt value:
      // only the file can unlock the vault.
      delete h.ctx.env.ENVVAULT_MASTER_PASSWORD;
      h.ctx.env.ENVVAULT_MASTER_PASSWORD_FILE = file;
      h.ctx.io.stdinIsTTY = false;
      h.state.password = "wrong-password";

      h.stdout.length = 0;
      expect(await listCommand(h.ctx, parseArgs([]))).toBe(ExitCode.Success);
      expect(h.output()).toContain("crono / dev");
    } finally {
      await h.cleanup();
    }
  });

  it("warns when the password file is group/world readable", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", {});

      const file = join(h.cwd, "loose.txt");
      await writeFile(file, h.state.password, "utf8");
      await chmod(file, 0o644);

      delete h.ctx.env.ENVVAULT_MASTER_PASSWORD;
      h.ctx.env.ENVVAULT_MASTER_PASSWORD_FILE = file;
      h.ctx.io.stdinIsTTY = false;

      await listCommand(h.ctx, parseArgs([]));
      expect(h.errors()).toContain("readable by other users");
    } finally {
      await h.cleanup();
    }
  });

  it("fails clearly when the password file is missing", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", {});
      delete h.ctx.env.ENVVAULT_MASTER_PASSWORD;
      h.ctx.env.ENVVAULT_MASTER_PASSWORD_FILE = join(h.cwd, "does-not-exist");
      h.ctx.io.stdinIsTTY = false;

      await expect(listCommand(h.ctx, parseArgs([]))).rejects.toThrow(/does not exist/);
    } finally {
      await h.cleanup();
    }
  });

  it("accepts a piped password for commands that do not use stdin", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { A: "1" });

      h.ctx.io.stdinIsTTY = false;
      h.state.stdin = `${h.state.password}\n`;
      h.state.password = "wrong-password";

      h.stdout.length = 0;
      expect(await listCommand(h.ctx, parseArgs([]))).toBe(ExitCode.Success);
      expect(h.output()).toContain("crono / dev");
    } finally {
      await h.cleanup();
    }
  });

  it("never treats a piped value as the password for `set --stdin`", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", {});

      h.ctx.io.stdinIsTTY = false;
      h.state.stdin = "the-secret-value";

      await expect(setCommand(h.ctx, parseArgs(["NEW_SECRET", "--stdin"]))).rejects.toBeInstanceOf(
        VaultLockedError,
      );
    } finally {
      await h.cleanup();
    }
  });

  it("unlocks directly with a password value (used by the TUI)", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { A: "1" });

      const unlocked = await unlockWithPasswordValue(h.ctx, h.state.password);
      expect(unlocked.vault.projects.crono?.environments.dev?.secrets.A?.value).toBe("1");

      await expect(unlockWithPasswordValue(h.ctx, "wrong-password")).rejects.toBeInstanceOf(
        WrongPasswordError,
      );
    } finally {
      await h.cleanup();
    }
  });
});
