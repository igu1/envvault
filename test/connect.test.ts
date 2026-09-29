import { describe, expect, it } from "vitest";

import { connectCommand } from "../src/commands/connect";
import { readServerConfig } from "../src/server/config";
import { createShareToken, upsertShare } from "../src/server/manage";
import { startShareServer } from "../src/server/service";
import { loadVault } from "../src/core/vault";
import { resolveSecret } from "../src/core/resolver";
import { openVault } from "../src/core/unlock";
import { parseArgs } from "../src/utils/args";
import { ExitCode, ShareAuthError, UsageError } from "../src/utils/errors";
import { createHarness, setupProject } from "./helpers";
import type { Harness } from "./helpers";
import type { RunningServer } from "../src/server/service";

const TOKEN_SHAPE = "evt_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";

describe("commands/connect argument handling", () => {
  it("rejects a scope given as a positional instead of a flag", async () => {
    const h = await createHarness();
    try {
      await expect(
        connectCommand(h.ctx, parseArgs(["ev.example.com", "global", "--token", TOKEN_SHAPE])),
      ).rejects.toThrow(/Unexpected argument: global/);
    } finally {
      await h.cleanup();
    }
  });

  it("suggests the dashed flag in the hint", async () => {
    const h = await createHarness();
    try {
      const error = await connectCommand(h.ctx, parseArgs(["ev.example.com", "shared"])).catch(
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).hint).toContain("--shared");
    } finally {
      await h.cleanup();
    }
  });

  it("still rejects a malformed token when no extra arguments are given", async () => {
    const h = await createHarness();
    try {
      await expect(
        connectCommand(h.ctx, parseArgs(["ev.example.com", "--token", "not-a-token"])),
      ).rejects.toThrow(/does not look like an EnvVault share token/);
    } finally {
      await h.cleanup();
    }
  });
});

describe("commands/connect transport warning", () => {
  it("warns before anything else when the token would cross the network in the clear", async () => {
    const h = await createHarness();
    try {
      // Shape validation fails after the warning, so no network is touched.
      await expect(
        connectCommand(h.ctx, parseArgs(["ev.example.com", "--token", "not-a-token"])),
      ).rejects.toThrow();
      expect(h.errors()).toContain("unencrypted");
      expect(h.errors()).toContain("https://ev.example.com");
    } finally {
      await h.cleanup();
    }
  });

  it("does not warn for https or for loopback", async () => {
    for (const url of ["https://ev.example.com", "http://127.0.0.1:8787", "http://localhost:8787"]) {
      const h = await createHarness();
      try {
        await expect(
          connectCommand(h.ctx, parseArgs([url, "--token", "not-a-token"])),
        ).rejects.toThrow();
        expect(h.errors()).not.toContain("unencrypted");
      } finally {
        await h.cleanup();
      }
    }
  });
});

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

/** A server vault that shares DATABASE_URL, plus a fresh client vault. */
async function twoSides(): Promise<{
  server: Harness;
  client: Harness;
  running: RunningServer;
  url: string;
  token: string;
}> {
  const server = await createHarness();
  await setupProject(server, "crono", "dev", {
    DATABASE_URL: "postgres://shared",
    STRIPE_KEY: "sk_secret",
  });
  await upsertShare(server.home, { project: "crono", environment: "dev", keys: ["DATABASE_URL"] });
  const { token } = await createShareToken(server.home, "client", { shares: "all", backup: false });
  const running = await startServer(server);

  const client = await createHarness();
  await setupProject(client, "app", "prod", {});

  return { server, client, running, url: `http://127.0.0.1:${running.port}`, token };
}

describe("commands/connect", () => {
  it("lists available shares without writing anything", async () => {
    const { server, client, running, url, token } = await twoSides();
    try {
      expect(
        await connectCommand(client.ctx, parseArgs([url, "--token", token, "--list"])),
      ).toBe(ExitCode.Success);
      expect(client.output()).toContain("crono/dev");
      expect(client.output()).toContain("DATABASE_URL");
    } finally {
      await running.close();
      await client.cleanup();
      await server.cleanup();
    }
  });

  it("pulls a share into a chosen project/environment", async () => {
    const { server, client, running, url, token } = await twoSides();
    try {
      const code = await connectCommand(
        client.ctx,
        parseArgs([url, "--token", token, "--project", "app", "--env", "prod", "--yes"]),
      );
      expect(code).toBe(ExitCode.Success);
      expect(client.output()).toContain("Stored 1 key(s) in app/prod");

      const vault = await loadVault(client.home, "test-master-password");
      expect(
        resolveSecret(vault, { project: "app", environment: "prod" }, "DATABASE_URL")?.value,
      ).toBe("postgres://shared");
      // The allowlist is respected: STRIPE_KEY was never shared.
      expect(client.output()).not.toContain("sk_secret");
    } finally {
      await running.close();
      await client.cleanup();
      await server.cleanup();
    }
  });

  it("can store into global secrets", async () => {
    const { server, client, running, url, token } = await twoSides();
    try {
      expect(
        await connectCommand(client.ctx, parseArgs([url, "--token", token, "--global", "--yes"])),
      ).toBe(ExitCode.Success);
      const vault = await loadVault(client.home, "test-master-password");
      expect(vault.globals.DATABASE_URL?.value).toBe("postgres://shared");
    } finally {
      await running.close();
      await client.cleanup();
      await server.cleanup();
    }
  });

  it("writes nothing on --dry-run", async () => {
    const { server, client, running, url, token } = await twoSides();
    try {
      expect(
        await connectCommand(client.ctx, parseArgs([url, "--token", token, "--global", "--dry-run"])),
      ).toBe(ExitCode.Success);
      expect(client.output()).toContain("Dry run");
      const vault = await loadVault(client.home, "test-master-password");
      expect(vault.globals.DATABASE_URL).toBeUndefined();
    } finally {
      await running.close();
      await client.cleanup();
      await server.cleanup();
    }
  });

  it("aborts when the confirmation is declined", async () => {
    const { server, client, running, url, token } = await twoSides();
    try {
      client.state.confirm = false;
      expect(
        await connectCommand(client.ctx, parseArgs([url, "--token", token, "--global"])),
      ).toBe(ExitCode.Success);
      expect(client.output()).toContain("Aborted");
      const vault = await loadVault(client.home, "test-master-password");
      expect(vault.globals.DATABASE_URL).toBeUndefined();
    } finally {
      await running.close();
      await client.cleanup();
      await server.cleanup();
    }
  });

  it("rejects a wrong token without writing", async () => {
    const { server, client, running, url, token } = await twoSides();
    try {
      const wrong = `${token.slice(0, -2)}xy`;
      await expect(
        connectCommand(client.ctx, parseArgs([url, "--token", wrong, "--global", "--yes"])),
      ).rejects.toThrow(ShareAuthError);
      const vault = await loadVault(client.home, "test-master-password");
      expect(vault.globals.DATABASE_URL).toBeUndefined();
    } finally {
      await running.close();
      await client.cleanup();
      await server.cleanup();
    }
  });
});
