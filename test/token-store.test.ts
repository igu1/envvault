import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { connectCommand } from "../src/commands/connect";
import { syncCommand } from "../src/commands/sync";
import { tokensCommand } from "../src/commands/tokens";
import { openVault } from "../src/core/unlock";
import { readServerConfig } from "../src/server/config";
import { createShareToken, upsertShare } from "../src/server/manage";
import { startShareServer } from "../src/server/service";
import {
  clearServerTokens,
  findServerTokens,
  listServerTokens,
  maskToken,
  readTokenStore,
  removeServerToken,
  saveServerToken,
  validateTokenStore,
} from "../src/server/token-store";
import { parseArgs } from "../src/utils/args";
import { ExitCode, UsageError } from "../src/utils/errors";
import { createHarness, setupProject } from "./helpers";
import type { Harness } from "./helpers";
import type { RunningServer } from "../src/server/service";

const URL_A = "https://ev.example.com";
const URL_B = "https://other.example.com";
const TOKEN_A = "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "evt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("server/token-store", () => {
  it("starts empty and reports nothing saved", async () => {
    const h = await createHarness();
    try {
      expect(await listServerTokens(h.home)).toEqual([]);
      expect(await findServerTokens(h.home, URL_A)).toEqual([]);
      expect((await readTokenStore(h.home)).tokens).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });

  it("saves, deduplicates, finds and removes tokens per server", async () => {
    const h = await createHarness();
    try {
      const first = await saveServerToken(h.home, { url: URL_A, token: TOKEN_A, label: "laptop" });
      expect(first.created).toBe(true);

      const again = await saveServerToken(h.home, { url: URL_A, token: TOKEN_A });
      expect(again.created).toBe(false);
      expect(await findServerTokens(h.home, URL_A)).toHaveLength(1);

      await saveServerToken(h.home, { url: URL_A, token: TOKEN_B });
      await saveServerToken(h.home, { url: URL_B, token: TOKEN_B });
      expect(await findServerTokens(h.home, URL_A)).toHaveLength(2);
      expect(await listServerTokens(h.home)).toHaveLength(3);

      expect(await removeServerToken(h.home, URL_A, TOKEN_B)).toBe(1);
      expect(await findServerTokens(h.home, URL_A)).toHaveLength(1);

      expect(await removeServerToken(h.home, URL_A)).toBe(1);
      expect(await findServerTokens(h.home, URL_A)).toHaveLength(0);
      expect(await clearServerTokens(h.home)).toBe(1);
      expect(await listServerTokens(h.home)).toEqual([]);
      expect(await clearServerTokens(h.home)).toBe(0);
    } finally {
      await h.cleanup();
    }
  });

  it("writes the store with 0600 permissions", async () => {
    const h = await createHarness();
    try {
      await saveServerToken(h.home, { url: URL_A, token: TOKEN_A });
      const info = await stat(join(h.home, "share-tokens.json"));
      expect(info.mode & 0o777).toBe(0o600);
    } finally {
      await h.cleanup();
    }
  });

  it("masks tokens so they cannot be reused from a listing", () => {
    const masked = maskToken(TOKEN_A);
    expect(masked).not.toBe(TOKEN_A);
    expect(masked).not.toContain(TOKEN_A);
    expect(masked.startsWith("evt_aaaa")).toBe(true);
    expect(maskToken("evt_short").length).toBeLessThan(20);
  });

  it("rejects malformed documents", () => {
    expect(() => validateTokenStore(null)).toThrow(/JSON object/);
    expect(() => validateTokenStore({ tokens: "nope" })).toThrow(/"tokens" must be an array/);
    expect(() => validateTokenStore({ version: 99 })).toThrow(/newer EnvVault/);
    expect(() => validateTokenStore({ tokens: [{ url: "not-a-url", token: TOKEN_A }] })).toThrow(
      /http\(s\) URL/,
    );
    expect(() => validateTokenStore({ tokens: [{ url: URL_A, token: "" }] })).toThrow(/missing/);
  });
});

describe("commands/tokens", () => {
  it("lists masked tokens and reports when there are none", async () => {
    const h = await createHarness();
    try {
      expect(await tokensCommand(h.ctx, parseArgs(["list"]))).toBe(ExitCode.Success);
      expect(h.output()).toContain("None yet.");

      await saveServerToken(h.home, { url: URL_A, token: TOKEN_A, label: "laptop" });

      h.stdout.length = 0;
      expect(await tokensCommand(h.ctx, parseArgs([]))).toBe(ExitCode.Success);
      expect(h.output()).toContain(URL_A);
      expect(h.output()).toContain("laptop");
      // The full token must never be echoed.
      expect(h.output()).not.toContain(TOKEN_A);
    } finally {
      await h.cleanup();
    }
  });

  it("removes by url, forgivingly, and supports --all", async () => {
    const h = await createHarness();
    try {
      await saveServerToken(h.home, { url: URL_A, token: TOKEN_A });
      await saveServerToken(h.home, { url: URL_B, token: TOKEN_B });

      // A bare host must match the scheme-qualified entry.
      expect(await tokensCommand(h.ctx, parseArgs(["remove", "ev.example.com"]))).toBe(
        ExitCode.Success,
      );
      expect(await findServerTokens(h.home, URL_A)).toHaveLength(0);
      expect(await findServerTokens(h.home, URL_B)).toHaveLength(1);

      expect(
        await tokensCommand(h.ctx, parseArgs(["remove", "https://nowhere.example.com"])),
      ).toBe(ExitCode.Error);

      h.stdout.length = 0;
      expect(await tokensCommand(h.ctx, parseArgs(["remove", "--all"]))).toBe(ExitCode.Success);
      expect(h.output()).toContain("Removed 1 saved token");
      expect(await listServerTokens(h.home)).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });

  it("has no subcommand other than list and remove", async () => {
    const h = await createHarness();
    try {
      await expect(tokensCommand(h.ctx, parseArgs(["bogus"]))).rejects.toThrow(
        /Unknown tokens subcommand/,
      );
    } finally {
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration with a live server
// ---------------------------------------------------------------------------

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

interface Sides {
  server: Harness;
  client: Harness;
  running: RunningServer;
  url: string;
  token: string;
}

async function twoSides(): Promise<Sides> {
  const server = await createHarness();
  await setupProject(server, "crono", "dev", { DATABASE_URL: "postgres://shared" });
  await upsertShare(server.home, { project: "crono", environment: "dev", keys: ["DATABASE_URL"] });
  const { token } = await createShareToken(server.home, "client", { shares: "all", backup: true });
  const running = await startServer(server);

  const client = await createHarness();
  await setupProject(client, "app", "prod", {});

  return { server, client, running, url: `http://127.0.0.1:${running.port}`, token };
}

async function closeAll(sides: Sides): Promise<void> {
  await sides.running.close();
  await sides.client.cleanup();
  await sides.server.cleanup();
}

describe("token persistence", () => {
  it("saves the token after a successful connect and reuses it silently", async () => {
    const sides = await twoSides();
    const { client, url, token } = sides;
    try {
      expect(
        await connectCommand(client.ctx, parseArgs([url, "--token", token, "--global", "--yes"])),
      ).toBe(ExitCode.Success);
      expect(client.output()).toContain("Token saved for");
      expect(await findServerTokens(client.home, url)).toHaveLength(1);

      // Second run: no --token at all. The harness password is not a valid
      // token, so success proves the saved one was used rather than prompted for.
      client.stdout.length = 0;
      expect(
        await connectCommand(client.ctx, parseArgs([url, "--global", "--yes"])),
      ).toBe(ExitCode.Success);
      expect(client.output()).toContain("Stored 1 key(s)");
      expect(client.output()).not.toContain("Token saved for");
    } finally {
      await closeAll(sides);
    }
  });

  it("does not save with --no-save and then requires a token", async () => {
    const sides = await twoSides();
    const { client, url, token } = sides;
    try {
      expect(
        await connectCommand(
          client.ctx,
          parseArgs([url, "--token", token, "--global", "--yes", "--no-save"]),
        ),
      ).toBe(ExitCode.Success);
      expect(await findServerTokens(client.home, url)).toHaveLength(0);

      client.ctx.io.stdinIsTTY = false;
      await expect(connectCommand(client.ctx, parseArgs([url, "--global", "--yes"]))).rejects.toThrow(
        UsageError,
      );
    } finally {
      await closeAll(sides);
    }
  });

  it("does not save when ENVVAULT_NO_TOKEN_STORE is set", async () => {
    const sides = await twoSides();
    const { client, url, token } = sides;
    try {
      client.ctx.env.ENVVAULT_NO_TOKEN_STORE = "1";
      expect(
        await connectCommand(client.ctx, parseArgs([url, "--token", token, "--global", "--yes"])),
      ).toBe(ExitCode.Success);
      expect(await findServerTokens(client.home, url)).toHaveLength(0);
    } finally {
      await closeAll(sides);
    }
  });

  it("never saves a token the server rejected", async () => {
    const sides = await twoSides();
    const { client, url, token } = sides;
    try {
      const wrong = `${token.slice(0, -2)}xy`;
      await expect(
        connectCommand(client.ctx, parseArgs([url, "--token", wrong, "--global", "--yes"])),
      ).rejects.toThrow();
      expect(await findServerTokens(client.home, url)).toHaveLength(0);
    } finally {
      await closeAll(sides);
    }
  });

  it("lets sync reuse a token saved by an earlier sync", async () => {
    const sides = await twoSides();
    const { client, url, token } = sides;
    try {
      expect(
        await syncCommand(client.ctx, parseArgs(["push", url, "--token", token, "--id", "laptop"])),
      ).toBe(ExitCode.Success);
      expect(await findServerTokens(client.home, url)).toHaveLength(1);

      // No --token this time.
      client.stdout.length = 0;
      expect(await syncCommand(client.ctx, parseArgs(["list", url]))).toBe(ExitCode.Success);
      expect(client.output()).toContain("laptop");
    } finally {
      await closeAll(sides);
    }
  });

  it("asks which token to use when several are saved", async () => {
    const sides = await twoSides();
    const { client, url, token } = sides;
    try {
      await saveServerToken(client.home, { url, token, label: "first" });
      await saveServerToken(client.home, {
        url,
        token: "evt_ccccccccccccccccccccccccccccccccccccccccccc",
        label: "second",
      });

      // Non-interactive with an ambiguous choice is a usage error, not a guess.
      client.ctx.io.stdinIsTTY = false;
      await expect(connectCommand(client.ctx, parseArgs([url, "--global"]))).rejects.toThrow(
        /2 tokens are saved/,
      );
    } finally {
      await closeAll(sides);
    }
  });

  it("stores the saved token only in the 0600 store", async () => {
    const sides = await twoSides();
    const { client, url, token } = sides;
    try {
      await connectCommand(client.ctx, parseArgs([url, "--token", token, "--list"]));
      const store = await readFile(join(client.home, "share-tokens.json"), "utf8");
      expect(store).toContain(token);
      expect((await stat(join(client.home, "share-tokens.json"))).mode & 0o777).toBe(0o600);
      expect((await readTokenStore(client.home)).tokens).toHaveLength(1);
    } finally {
      await closeAll(sides);
    }
  });
});
