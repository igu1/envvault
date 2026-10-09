import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { syncCommand } from "../src/commands/sync";
import { uiCommand } from "../src/commands/ui";
import { loadVault } from "../src/core/vault";
import { openVault } from "../src/core/unlock";
import { readServerConfig } from "../src/server/config";
import { createShareToken, upsertShare } from "../src/server/manage";
import { startShareServer } from "../src/server/service";
import { listServerTokens, saveServerToken } from "../src/server/token-store";
import { parseArgs } from "../src/utils/args";
import { createHarness, setupProject } from "./helpers";
import type { Harness } from "./helpers";
import type { RunningServer } from "../src/server/service";

/** Scripted answers for the mocked prompt layer, filled per test. */
const state = vi.hoisted(() => ({
  selects: [] as (string | null)[],
  texts: [] as (string | null)[],
  passwords: [] as (string | null)[],
  confirms: [] as (boolean | null)[],
  notes: [] as Array<{ message: string; title: string | undefined }>,
  logs: [] as Array<{ level: string; message: string }>,
}));

vi.mock("../src/ui/prompts", () => ({
  askSelect: async () => state.selects.shift() ?? null,
  askText: async () => state.texts.shift() ?? null,
  askPassword: async () => state.passwords.shift() ?? null,
  askConfirm: async () => state.confirms.shift() ?? null,
  askMultiSelect: async () => null,
}));

vi.mock("@clack/prompts", () => ({
  intro: () => undefined,
  outro: () => undefined,
  note: (message: string, title?: string) => {
    state.notes.push({ message, title });
  },
  log: {
    info: (message: string) => state.logs.push({ level: "info", message }),
    success: (message: string) => state.logs.push({ level: "success", message }),
    warn: (message: string) => state.logs.push({ level: "warn", message }),
    error: (message: string) => state.logs.push({ level: "error", message }),
  },
}));

beforeEach(() => {
  state.selects.length = 0;
  state.texts.length = 0;
  state.passwords.length = 0;
  state.confirms.length = 0;
  state.notes.length = 0;
  state.logs.length = 0;
});

async function runUi(h: Harness): Promise<number> {
  h.ctx.env.ENVVAULT_MASTER_PASSWORD = "test-master-password";
  return await uiCommand(h.ctx, parseArgs([]));
}

interface Owner {
  owner: Harness;
  running: RunningServer;
  url: string;
  token: string;
  close: () => Promise<void>;
}

async function startOwner(backup: boolean): Promise<Owner> {
  const owner = await createHarness();
  await setupProject(owner, "crono", "dev", { DATABASE_URL: "postgres://owner" });
  const { token } = await createShareToken(owner.home, "peer", { shares: "all", backup });
  const { key } = await openVault(owner.ctx);
  const running = await startShareServer({
    home: owner.home,
    config: await readServerConfig(owner.home),
    vaultKey: key.key,
    version: "9.9.9",
    host: "127.0.0.1",
    port: 0,
  });
  return {
    owner,
    running,
    url: `http://127.0.0.1:${running.port}`,
    token,
    close: async () => {
      await running.close();
      await owner.cleanup();
    },
  };
}

describe("ui/import + export", () => {
  it("exports a merged environment scope to the screen", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { DATABASE_URL: "postgres://dev" });
      state.selects.push("importExport", "export", "here:crono/dev", "env", "screen", "exit");

      expect(await runUi(h)).toBe(0);
      const exported = state.notes.map((entry) => entry.message).join("\n");
      expect(exported).toContain("DATABASE_URL=postgres://dev");
    } finally {
      await h.cleanup();
    }
  });

  it("imports a .env file into the current environment", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", {});
      await writeFile(join(h.cwd, "incoming.env"), "STRIPE_KEY=sk_test_123\n", "utf8");

      state.selects.push("importExport", "import", "here:crono/dev", "exit");
      state.texts.push("incoming.env");
      state.confirms.push(false);

      expect(await runUi(h)).toBe(0);
      const vault = await loadVault(h.home, "test-master-password");
      expect(vault.projects.crono?.environments.dev?.secrets.STRIPE_KEY?.value).toBe("sk_test_123");
    } finally {
      await h.cleanup();
    }
  });
});

describe("ui/projects", () => {
  it("creates a project with environments", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "seed", "dev", {});
      state.selects.push("projects", "add", "back", "exit");
      state.texts.push("billing", "dev,prod");

      expect(await runUi(h)).toBe(0);
      const vault = await loadVault(h.home, "test-master-password");
      expect(Object.keys(vault.projects.billing?.environments ?? {}).sort()).toEqual(["dev", "prod"]);
    } finally {
      await h.cleanup();
    }
  });
});

describe("ui/saved tokens", () => {
  it("forgets every saved token", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", {});
      await saveServerToken(h.home, { url: "http://127.0.0.1:8787", token: "evt_abcdefghijklmnop" });
      expect(await listServerTokens(h.home)).toHaveLength(1);

      state.selects.push("savedTokens", "clear", "exit");
      state.confirms.push(true);

      expect(await runUi(h)).toBe(0);
      expect(await listServerTokens(h.home)).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });
});

describe("ui/connect", () => {
  it("pulls shared keys into global scope", async () => {
    const server = await startOwner(false);
    await upsertShare(server.owner.home, {
      project: "crono",
      environment: "dev",
      keys: ["DATABASE_URL"],
    });
    const h = await createHarness();
    try {
      await setupProject(h, "local", "dev", {});
      await saveServerToken(h.home, { url: server.url, token: server.token });

      state.selects.push("connect", server.url, "global", "exit");
      state.confirms.push(true);

      expect(await runUi(h)).toBe(0);
      const vault = await loadVault(h.home, "test-master-password");
      expect(vault.globals.DATABASE_URL?.value).toBe("postgres://owner");

      const preview = state.notes.map((entry) => entry.message).join("\n");
      expect(preview).toContain("DATABASE_URL");
      expect(preview).not.toContain("postgres://owner");
    } finally {
      await h.cleanup();
      await server.close();
    }
  });
});

describe("ui/backups", () => {
  it("pushes this vault and lists it", async () => {
    const server = await startOwner(true);
    const h = await createHarness();
    try {
      await setupProject(h, "local", "dev", { LOCAL_ONLY: "keep-me" });
      await saveServerToken(h.home, { url: server.url, token: server.token });

      state.selects.push("backups", server.url, "push", "list", "back", "exit");
      state.texts.push("laptop");

      expect(await runUi(h)).toBe(0);
      const listed = state.notes.map((entry) => entry.message).join("\n");
      expect(listed).toContain("laptop");
    } finally {
      await h.cleanup();
      await server.close();
    }
  });

  it("pulls a backup, replacing the vault and reloading it", async () => {
    const server = await startOwner(true);
    const h = await createHarness();
    try {
      await setupProject(h, "local", "dev", { LOCAL_ONLY: "keep-me" });
      await syncCommand(
        server.owner.ctx,
        parseArgs(["push", server.url, "--token", server.token, "--id", "laptop", "--no-save"]),
      );
      await saveServerToken(h.home, { url: server.url, token: server.token });

      state.selects.push("backups", server.url, "pull", "exit");
      state.confirms.push(true);

      expect(await runUi(h)).toBe(0);
      const restored = await loadVault(h.home, "test-master-password");
      expect(restored.projects.crono?.environments.dev?.secrets.DATABASE_URL?.value).toBe(
        "postgres://owner",
      );

      const dir = await import("node:fs/promises").then((fs) => fs.readdir(h.home));
      expect(dir.some((entry) => entry.startsWith("vault.enc.bak-"))).toBe(true);
    } finally {
      await h.cleanup();
      await server.close();
    }
  });
});
