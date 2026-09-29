import { describe, expect, it } from "vitest";

import {
  getScopedSecretEntry,
  listScopeSecretNames,
  resolveSecret,
  resolveSecretDetails,
  resolveSecrets,
} from "../src/core/resolver";
import type { SecretEntry, VaultData } from "../src/core/types";

function entry(value: string): SecretEntry {
  return { value, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

function makeVault(): VaultData {
  return {
    version: 1,
    globals: {
      GLOBAL_ONLY: entry("global-only"),
      SHARED_NAME: entry("from-global"),
      OVERRIDE: entry("from-global"),
    },
    projects: {
      crono: {
        shared: {
          SHARED_NAME: entry("from-project"),
          PROJECT_ONLY: entry("project-only"),
        },
        environments: {
          dev: {
            secrets: {
              OVERRIDE: entry("from-environment"),
              DEV_ONLY: entry("dev-only"),
            },
          },
          production: { secrets: {} },
        },
      },
    },
  };
}

describe("resolver/resolveSecrets", () => {
  it("applies environment > project > global precedence", () => {
    const secrets = resolveSecrets(makeVault(), { project: "crono", environment: "dev" });
    expect(secrets.OVERRIDE).toBe("from-environment");
    expect(secrets.SHARED_NAME).toBe("from-project");
    expect(secrets.GLOBAL_ONLY).toBe("global-only");
    expect(secrets.PROJECT_ONLY).toBe("project-only");
    expect(secrets.DEV_ONLY).toBe("dev-only");
  });

  it("falls back to global when an environment has no override", () => {
    const secrets = resolveSecrets(makeVault(), { project: "crono", environment: "production" });
    expect(secrets.OVERRIDE).toBe("from-global");
    expect(secrets.SHARED_NAME).toBe("from-project");
  });

  it("only exposes globals for an unknown project", () => {
    const secrets = resolveSecrets(makeVault(), { project: "missing", environment: "dev" });
    expect(Object.keys(secrets).sort()).toEqual(["GLOBAL_ONLY", "OVERRIDE", "SHARED_NAME"]);
  });

  it("reports origins", () => {
    const details = resolveSecretDetails(makeVault(), { project: "crono", environment: "dev" });
    const origins = Object.fromEntries(details.map((detail) => [detail.name, detail.origin]));
    expect(origins.OVERRIDE).toBe("environment");
    expect(origins.SHARED_NAME).toBe("project");
    expect(origins.GLOBAL_ONLY).toBe("global");
  });

  it("never mutates the vault", () => {
    const vault = makeVault();
    const before = JSON.stringify(vault);
    resolveSecrets(vault, { project: "crono", environment: "dev" });
    resolveSecretDetails(vault, { project: "crono", environment: "dev" });
    resolveSecret(vault, { project: "crono", environment: "dev" }, "OVERRIDE");
    expect(JSON.stringify(vault)).toBe(before);
  });
});

describe("resolver/resolveSecret", () => {
  it("returns the highest-precedence value", () => {
    expect(resolveSecret(makeVault(), { project: "crono", environment: "dev" }, "OVERRIDE")?.origin).toBe(
      "environment",
    );
    expect(
      resolveSecret(makeVault(), { project: "crono", environment: "production" }, "OVERRIDE")?.origin,
    ).toBe("global");
  });

  it("returns undefined for unknown names", () => {
    expect(resolveSecret(makeVault(), { project: "crono", environment: "dev" }, "NOPE")).toBeUndefined();
  });
});

describe("resolver/scoped helpers", () => {
  it("reads exact scopes without precedence fallbacks", () => {
    const vault = makeVault();
    expect(getScopedSecretEntry(vault, { kind: "environment", project: "crono", environment: "production" }, "OVERRIDE")).toBeUndefined();
    expect(getScopedSecretEntry(vault, { kind: "global" }, "OVERRIDE")?.value).toBe("from-global");
    expect(getScopedSecretEntry(vault, { kind: "project", project: "crono" }, "SHARED_NAME")?.value).toBe("from-project");
  });

  it("lists names per scope", () => {
    const vault = makeVault();
    expect(listScopeSecretNames(vault, { kind: "global" })).toEqual([
      "GLOBAL_ONLY",
      "OVERRIDE",
      "SHARED_NAME",
    ]);
    expect(listScopeSecretNames(vault, { kind: "project", project: "crono" })).toEqual([
      "PROJECT_ONLY",
      "SHARED_NAME",
    ]);
    expect(
      listScopeSecretNames(vault, { kind: "environment", project: "crono", environment: "dev" }),
    ).toEqual(["DEV_ONLY", "OVERRIDE"]);
  });
});
