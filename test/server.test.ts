import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadVault } from "../src/core/vault";
import {
  defaultServerConfig,
  readServerConfig,
  validateServerConfig,
  writeServerConfig,
} from "../src/server/config";
import {
  createShareToken,
  describeGrant,
  listShares,
  listTokens,
  missingShareKeys,
  removeShare,
  revokeShareToken,
  setServerBinding,
  setServerEnabled,
  upsertShare,
} from "../src/server/manage";
import { createHarness, setupProject } from "./helpers";
import type { Harness } from "./helpers";

describe("server/config", () => {
  it("defaults to disabled, loopback, and creates nothing on read", async () => {
    const h = await createHarness();
    try {
      const config = await readServerConfig(h.home);
      expect(config).toEqual(defaultServerConfig());
      expect(config.enabled).toBe(false);
      expect(config.host).toBe("127.0.0.1");
      await expect(readFile(join(h.home, "server.json"), "utf8")).rejects.toThrow();
    } finally {
      await h.cleanup();
    }
  });

  it("round-trips through a 0600 file", async () => {
    const h = await createHarness();
    try {
      const config = defaultServerConfig();
      config.enabled = true;
      config.port = 9000;
      await writeServerConfig(h.home, config);
      expect(await readServerConfig(h.home)).toEqual(config);
    } finally {
      await h.cleanup();
    }
  });

  it("rejects malformed documents", () => {
    expect(() => validateServerConfig(null)).toThrow(/JSON object/);
    expect(() => validateServerConfig({ port: 70000 })).toThrow(/port/);
    expect(() => validateServerConfig({ shares: [{ project: "a", environment: "b", keys: "x" }] })).toThrow(
      /keys/,
    );
    expect(() =>
      validateServerConfig({
        shares: [
          { project: "a", environment: "b", keys: [] },
          { project: "a", environment: "b", keys: [] },
        ],
      }),
    ).toThrow(/duplicate share/);
    expect(() => validateServerConfig({ version: 99 })).toThrow(/newer EnvVault/);
  });

  it("never stores a raw token", async () => {
    const h = await createHarness();
    try {
      const { token } = await createShareToken(h.home, "laptop", { shares: "all", backup: false });
      const raw = await readFile(join(h.home, "server.json"), "utf8");
      expect(raw).not.toContain(token);
      expect(JSON.stringify(JSON.parse(raw))).not.toContain(token);
    } finally {
      await h.cleanup();
    }
  });
});

describe("server/manage", () => {
  async function withProject(): Promise<Harness> {
    const h = await createHarness();
    await setupProject(h, "crono", "dev", { DATABASE_URL: "postgres://x", STRIPE_KEY: "sk_1" });
    return h;
  }

  it("enables sharing and changes the binding", async () => {
    const h = await withProject();
    try {
      expect((await setServerEnabled(h.home, true)).enabled).toBe(true);
      const config = await setServerBinding(h.home, { host: "0.0.0.0", port: 0 });
      expect(config.host).toBe("0.0.0.0");
      expect(config.port).toBe(0);
      await expect(setServerBinding(h.home, { port: 70000 })).rejects.toThrow(/Invalid port/);
      expect((await setServerEnabled(h.home, false)).enabled).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  it("adds, updates and removes shares", async () => {
    const h = await withProject();
    try {
      const created = await upsertShare(h.home, {
        project: "crono",
        environment: "dev",
        keys: ["DATABASE_URL", "DATABASE_URL"],
        label: "Crono dev",
      });
      expect(created.created).toBe(true);
      expect(created.share.keys).toEqual(["DATABASE_URL"]);

      const updated = await upsertShare(h.home, {
        project: "crono",
        environment: "dev",
        keys: ["DATABASE_URL", "STRIPE_KEY"],
      });
      expect(updated.created).toBe(false);
      expect(updated.share.keys).toHaveLength(2);
      expect(await listShares(h.home)).toHaveLength(1);

      expect(await removeShare(h.home, "crono", "dev")).toBe(true);
      expect(await removeShare(h.home, "crono", "dev")).toBe(false);
      expect(await listShares(h.home)).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  it("requires at least one key per share", async () => {
    const h = await withProject();
    try {
      await expect(
        upsertShare(h.home, { project: "crono", environment: "dev", keys: ["  "] }),
      ).rejects.toThrow(/at least one key/);
    } finally {
      await h.cleanup();
    }
  });

  it("reports allowlisted names that no longer exist", async () => {
    const h = await withProject();
    try {
      const vault = await loadVault(h.home, "test-master-password");
      expect(missingShareKeys(vault, "crono", "dev", ["DATABASE_URL"])).toEqual([]);
      expect(missingShareKeys(vault, "crono", "dev", ["GONE"])).toEqual(["GONE"]);
    } finally {
      await h.cleanup();
    }
  });

  it("creates, lists and revokes tokens with grants", async () => {
    const h = await withProject();
    try {
      await upsertShare(h.home, { project: "crono", environment: "dev", keys: ["DATABASE_URL"] });
      const { token, record } = await createShareToken(h.home, "laptop", {
        shares: ["crono/dev"],
        backup: true,
      });
      expect(token.startsWith("evt_")).toBe(true);
      expect(describeGrant(record.grant)).toBe("1 share(s), backups");

      const tokens = await listTokens(h.home);
      expect(tokens).toHaveLength(1);
      expect(tokens[0]?.id).toBe(record.id);

      expect(await revokeShareToken(h.home, record.id)).toBe(true);
      expect(await revokeShareToken(h.home, record.id)).toBe(false);
      expect(await listTokens(h.home)).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  it("rejects malformed share references in a grant", async () => {
    const h = await withProject();
    try {
      await expect(
        createShareToken(h.home, "bad", { shares: ["not-a-ref"], backup: false }),
      ).rejects.toThrow(/share reference/);
    } finally {
      await h.cleanup();
    }
  });
});
