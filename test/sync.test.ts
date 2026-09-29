import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { syncCommand } from "../src/commands/sync";
import { openVault } from "../src/core/unlock";
import { loadVault } from "../src/core/vault";
import { readServerConfig } from "../src/server/config";
import { createShareToken } from "../src/server/manage";
import { startShareServer } from "../src/server/service";
import { parseArgs } from "../src/utils/args";
import { ExitCode, ShareAuthError } from "../src/utils/errors";
import { createHarness, setupProject } from "./helpers";
import type { Harness } from "./helpers";
import type { RunningServer } from "../src/server/service";

async function startServer(h: Harness): Promise<RunningServer> {
  const { key } = await openVault(h.ctx);
  const config = await readServerConfig(h.home);
  return await startShareServer({
    home: h.home,
    config,
    vaultKey: key.key,
    version: "9.9.9",
    host: "127.0.0.1",
    port: 0,
  });
}

interface Setup {
  owner: Harness;
  running: RunningServer;
  url: string;
  token: string;
}

async function setup(backup = true): Promise<Setup> {
  const owner = await createHarness();
  await setupProject(owner, "crono", "dev", { DATABASE_URL: "postgres://owner" });
  const { token } = await createShareToken(owner.home, "sync", { shares: "all", backup });
  const running = await startServer(owner);
  return { owner, running, url: `http://127.0.0.1:${running.port}`, token };
}

describe("commands/sync", () => {
  it("pushes the encrypted vault and lists it", async () => {
    const { owner, running, url, token } = await setup();
    try {
      expect(
        await syncCommand(owner.ctx, parseArgs(["push", url, "--token", token, "--id", "laptop"])),
      ).toBe(ExitCode.Success);
      expect(owner.output()).toContain("Pushed");

      expect(await syncCommand(owner.ctx, parseArgs(["list", url, "--token", token]))).toBe(
        ExitCode.Success,
      );
      expect(owner.output()).toContain("laptop");
    } finally {
      await running.close();
      await owner.cleanup();
    }
  });

  it("pulls a backup into another vault, keeping the previous vault.enc", async () => {
    const { owner, running, url, token } = await setup();
    const other = await createHarness();
    try {
      await setupProject(other, "other", "local", { LOCAL_ONLY: "keep-me" });
      await syncCommand(owner.ctx, parseArgs(["push", url, "--token", token, "--id", "laptop"]));

      expect(
        await syncCommand(
          other.ctx,
          parseArgs(["pull", url, "--token", token, "--id", "laptop", "--yes"]),
        ),
      ).toBe(ExitCode.Success);

      // The restored vault is the owner's vault.
      const restored = await loadVault(other.home, "test-master-password");
      expect(restored.projects.crono?.environments.dev?.secrets.DATABASE_URL?.value).toBe(
        "postgres://owner",
      );

      // The previous vault.enc was preserved.
      const dir = await import("node:fs/promises").then((fs) => fs.readdir(other.home));
      expect(dir.some((entry) => entry.startsWith("vault.enc.bak-"))).toBe(true);
    } finally {
      await running.close();
      await other.cleanup();
      await owner.cleanup();
    }
  });

  it("aborts a pull that is not confirmed", async () => {
    const { owner, running, url, token } = await setup();
    const other = await createHarness();
    try {
      await setupProject(other, "other", "local", { LOCAL_ONLY: "keep-me" });
      const before = await readFile(join(other.home, "vault.enc"), "utf8");
      await syncCommand(owner.ctx, parseArgs(["push", url, "--token", token, "--id", "laptop"]));

      other.state.confirm = false;
      expect(
        await syncCommand(other.ctx, parseArgs(["pull", url, "--token", token, "--id", "laptop"])),
      ).toBe(ExitCode.Success);
      expect(other.output()).toContain("Aborted");
      expect(await readFile(join(other.home, "vault.enc"), "utf8")).toBe(before);
    } finally {
      await running.close();
      await other.cleanup();
      await owner.cleanup();
    }
  });

  it("rejects pushes from a token without the backup grant", async () => {
    const { owner, running, url, token } = await setup(false);
    try {
      await expect(
        syncCommand(owner.ctx, parseArgs(["push", url, "--token", token, "--id", "laptop"])),
      ).rejects.toThrow(ShareAuthError);
    } finally {
      await running.close();
      await owner.cleanup();
    }
  });

  it("removes a backup", async () => {
    const { owner, running, url, token } = await setup();
    try {
      await syncCommand(owner.ctx, parseArgs(["push", url, "--token", token, "--id", "doomed"]));
      expect(
        await syncCommand(owner.ctx, parseArgs(["remove", url, "--token", token, "--id", "doomed"])),
      ).toBe(ExitCode.Success);
      owner.stdout.length = 0;
      await syncCommand(owner.ctx, parseArgs(["list", url, "--token", token]));
      expect(owner.output()).toContain("No backups yet.");
    } finally {
      await running.close();
      await owner.cleanup();
    }
  });

  it("stores backups as files with 0600 permissions", async () => {
    const { owner, running, url, token } = await setup();
    try {
      await syncCommand(owner.ctx, parseArgs(["push", url, "--token", token, "--id", "laptop"]));
      const info = await stat(join(owner.home, "backups", "laptop.json"));
      expect(info.mode & 0o777).toBe(0o600);
    } finally {
      await running.close();
      await owner.cleanup();
    }
  });
});
