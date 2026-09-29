import { describe, expect, it } from "vitest";

import { buildSharePayload, decryptShareEnvelope, encryptSharePayload } from "../src/server/share";
import { createToken, deriveTokenKey } from "../src/server/tokens";
import { shareRef, parseShareRef } from "../src/server/types";
import type { VaultData } from "../src/core/types";
import type { ShareDefinition } from "../src/server/types";

const ENTRY = (value: string) => ({ value, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });

const vault: VaultData = {
  version: 1,
  globals: { GLOBAL_TOKEN: ENTRY("global") },
  projects: {
    crono: {
      shared: { SHARED_KEY: ENTRY("shared") },
      environments: {
        dev: { secrets: { DATABASE_URL: ENTRY("postgres://dev"), SHARED_KEY: ENTRY("env-wins") } },
      },
    },
  },
};

function share(keys: string[]): ShareDefinition {
  return {
    project: "crono",
    environment: "dev",
    keys,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("server/share", () => {
  it("resolves only allowlisted names, using normal precedence", () => {
    const payload = buildSharePayload(vault, share(["DATABASE_URL", "SHARED_KEY", "GLOBAL_TOKEN"]), "now");
    expect(payload.secrets).toEqual({
      DATABASE_URL: "postgres://dev",
      SHARED_KEY: "env-wins",
      GLOBAL_TOKEN: "global",
    });
    expect(payload.missing).toEqual([]);
    // Nothing outside the allowlist leaks into the payload.
    expect(Object.keys(payload.secrets)).toHaveLength(3);
  });

  it("reports allowlisted names that are gone", () => {
    const payload = buildSharePayload(vault, share(["DATABASE_URL", "GONE"]), "now");
    expect(payload.missing).toEqual(["GONE"]);
    expect(payload.secrets).toEqual({ DATABASE_URL: "postgres://dev" });
  });

  it("round-trips a payload through a token", async () => {
    const { token, record } = await createToken("laptop", { shares: "all", backup: false }, "now");
    const salt = Buffer.from(record.salt, "base64");
    const key = await deriveTokenKey(token, salt);
    const payload = buildSharePayload(vault, share(["DATABASE_URL"]), "2026-02-02T00:00:00.000Z");

    const envelope = encryptSharePayload(payload, key, salt);
    expect(envelope.cipher).toBe("aes-256-gcm");
    // The plaintext value must not appear anywhere in the envelope.
    expect(JSON.stringify(envelope)).not.toContain("postgres://dev");

    const decrypted = await decryptShareEnvelope(envelope, token);
    expect(decrypted.secrets).toEqual({ DATABASE_URL: "postgres://dev" });
    expect(decrypted.exportedAt).toBe("2026-02-02T00:00:00.000Z");
  });

  it("refuses to decrypt with the wrong token", async () => {
    const { token, record } = await createToken("laptop", { shares: "all", backup: false }, "now");
    const { token: other } = await createToken("other", { shares: "all", backup: false }, "now");
    const salt = Buffer.from(record.salt, "base64");
    const key = await deriveTokenKey(token, salt);
    const envelope = encryptSharePayload(buildSharePayload(vault, share(["DATABASE_URL"]), "now"), key, salt);

    await expect(decryptShareEnvelope(envelope, other)).rejects.toThrow(/token is wrong/);
  });

  it("detects a tampered envelope", async () => {
    const { token, record } = await createToken("laptop", { shares: "all", backup: false }, "now");
    const salt = Buffer.from(record.salt, "base64");
    const key = await deriveTokenKey(token, salt);
    const envelope = encryptSharePayload(buildSharePayload(vault, share(["DATABASE_URL"]), "now"), key, salt);

    const tampered = { ...envelope, ciphertext: Buffer.from("nope").toString("base64") };
    await expect(decryptShareEnvelope(tampered, token)).rejects.toThrow(/token is wrong/);
  });
});

describe("server/types", () => {
  it("builds and parses share references", () => {
    expect(shareRef("crono", "dev")).toBe("crono/dev");
    expect(parseShareRef("crono/dev")).toEqual({ project: "crono", environment: "dev" });
    expect(parseShareRef("crono")).toBeNull();
    expect(parseShareRef("crono/dev/extra")).toBeNull();
    expect(parseShareRef("/dev")).toBeNull();
  });
});
