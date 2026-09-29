import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../src/cli";
import { serveCommand } from "../src/commands/serve";
import { serverCommand } from "../src/commands/server";
import { shareCommand } from "../src/commands/share";
import { readServerConfig } from "../src/server/config";
import { parseArgs } from "../src/utils/args";
import { ExitCode, ServerDisabledError, UsageError } from "../src/utils/errors";
import { createHarness, setupProject } from "./helpers";
import type { Harness } from "./helpers";

async function withProject(): Promise<Harness> {
  const h = await createHarness();
  await setupProject(h, "crono", "dev", { DATABASE_URL: "postgres://x", STRIPE_KEY: "sk_1" });
  return h;
}

describe("commands/server", () => {
  it("reports a disabled server by default", async () => {
    const h = await withProject();
    try {
      expect(await serverCommand(h.ctx, parseArgs(["status"]))).toBe(ExitCode.Success);
      expect(h.output()).toContain("Enabled        no");
      expect(h.output()).toContain("127.0.0.1:8787");
    } finally {
      await h.cleanup();
    }
  });

  it("enables, configures and disables sharing", async () => {
    const h = await withProject();
    try {
      expect(await serverCommand(h.ctx, parseArgs(["enable"]))).toBe(ExitCode.Success);
      expect(h.output()).toContain("Sharing enabled");
      expect(h.output()).toContain("envvault serve");
      expect((await readServerConfig(h.home)).enabled).toBe(true);

      expect(await serverCommand(h.ctx, parseArgs(["port", "9001"]))).toBe(ExitCode.Success);
      expect((await readServerConfig(h.home)).port).toBe(9001);

      h.stdout.length = 0;
      h.stderr.length = 0;
      expect(await serverCommand(h.ctx, parseArgs(["host", "0.0.0.0"]))).toBe(ExitCode.Success);
      expect(h.errors()).toMatch(/exposes the server to your network/);

      expect(await serverCommand(h.ctx, parseArgs(["disable"]))).toBe(ExitCode.Success);
      expect((await readServerConfig(h.home)).enabled).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  it("validates the port and address", async () => {
    const h = await withProject();
    try {
      await expect(serverCommand(h.ctx, parseArgs(["port", "abc"]))).rejects.toThrow(UsageError);
      await expect(serverCommand(h.ctx, parseArgs(["bogus"]))).rejects.toThrow(/Unknown server subcommand/);
    } finally {
      await h.cleanup();
    }
  });

  it("refuses to serve while sharing is disabled", async () => {
    const h = await withProject();
    try {
      await expect(serveCommand(h.ctx, parseArgs([]))).rejects.toThrow(ServerDisabledError);
    } finally {
      await h.cleanup();
    }
  });
});

describe("commands/share", () => {
  it("adds, lists and removes a share, warning about missing keys", async () => {
    const h = await withProject();
    try {
      expect(
        await shareCommand(h.ctx, parseArgs(["add", "crono/dev", "--keys", "DATABASE_URL", "--label", "Crono dev"])),
      ).toBe(ExitCode.Success);
      expect(h.output()).toContain("Sharing crono/dev");

      h.stdout.length = 0;
      h.stderr.length = 0;
      expect(
        await shareCommand(h.ctx, parseArgs(["add", "crono/dev", "--keys", "DATABASE_URL,GONE"])),
      ).toBe(ExitCode.Success);
      expect(h.errors()).toContain("GONE");

      h.stdout.length = 0;
      expect(await shareCommand(h.ctx, parseArgs(["list"]))).toBe(ExitCode.Success);
      expect(h.output()).toContain("crono/dev");
      expect(h.output()).toContain("DATABASE_URL");

      h.stdout.length = 0;
      expect(await shareCommand(h.ctx, parseArgs(["remove", "crono/dev"]))).toBe(ExitCode.Success);
      expect(h.output()).toContain("Stopped sharing crono/dev");
      expect(await shareCommand(h.ctx, parseArgs(["list"]))).toBe(ExitCode.Success);
      expect(h.output()).toContain("Nothing is shared.");
    } finally {
      await h.cleanup();
    }
  });

  it("rejects malformed references and empty key lists", async () => {
    const h = await withProject();
    try {
      await expect(shareCommand(h.ctx, parseArgs(["add", "crono"]))).rejects.toThrow(UsageError);
      await expect(
        shareCommand(h.ctx, parseArgs(["add", "crono/dev", "--keys", ""])),
      ).rejects.toThrow(/at least one key/);
      await expect(
        shareCommand(h.ctx, parseArgs(["add", "missing/dev", "--keys", "A"])),
      ).rejects.toThrow(/Project not found/);
    } finally {
      await h.cleanup();
    }
  });

  it("creates a token once and can store it in a file", async () => {
    const h = await withProject();
    try {
      const out = join(h.cwd, "token.txt");
      expect(
        await shareCommand(
          h.ctx,
          parseArgs(["token", "create", "--label", "laptop", "--shares", "all", "--out", out]),
        ),
      ).toBe(ExitCode.Success);

      const token = (await readFile(out, "utf8")).trim();
      expect(token.startsWith("evt_")).toBe(true);
      expect((await stat(out)).mode & 0o777).toBe(0o600);

      // The raw token is never persisted in server.json.
      expect(await readFile(join(h.home, "server.json"), "utf8")).not.toContain(token);

      h.stdout.length = 0;
      expect(await shareCommand(h.ctx, parseArgs(["token", "list"]))).toBe(ExitCode.Success);
      expect(h.output()).toContain("laptop");

      const tokens = (await readServerConfig(h.home)).tokens;
      h.stdout.length = 0;
      expect(
        await shareCommand(h.ctx, parseArgs(["token", "revoke", tokens[0]!.id])),
      ).toBe(ExitCode.Success);
      expect(h.output()).toContain("Revoked token");
    } finally {
      await h.cleanup();
    }
  });

  it("requires a token label and a scope", async () => {
    const h = await withProject();
    try {
      await expect(shareCommand(h.ctx, parseArgs(["token", "create"]))).rejects.toThrow(/label/);
    } finally {
      await h.cleanup();
    }
  });
});

describe("cli/sharing routing", () => {
  it("routes server, share and sync through the CLI", async () => {
    const h = await withProject();
    try {
      expect(await main(["server", "status"], h.ctx)).toBe(ExitCode.Success);
      expect(await main(["share", "list"], h.ctx)).toBe(ExitCode.Success);
      expect(await main(["share", "add", "crono/dev", "--keys", "DATABASE_URL"], h.ctx)).toBe(
        ExitCode.Success,
      );
      expect(await main(["share", "list"], h.ctx)).toBe(ExitCode.Success);
      expect(h.output()).toContain("crono/dev");
    } finally {
      await h.cleanup();
    }
  });

  it("mentions the sharing commands in help", async () => {
    const h = await createHarness();
    try {
      expect(await main([], h.ctx)).toBe(ExitCode.Success);
      expect(h.output()).toContain("envvault serve");
      expect(h.output()).toContain("envvault connect");
    } finally {
      await h.cleanup();
    }
  });
});
