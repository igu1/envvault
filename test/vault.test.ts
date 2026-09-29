import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { deriveKey } from "../src/core/crypto";
import {
  addEnvironment,
  addProject,
  createEmptyVault,
  deleteSecret,
  getSecretEntry,
  hasEnvironment,
  listEnvironments,
  listProjects,
  loadVault,
  loadVaultWithKey,
  removeProject,
  saveVault,
  saveVaultWithKey,
  setSecret,
  validateVaultData,
} from "../src/core/vault";
import { WrongPasswordError, ConfigError, EnvironmentNotFoundError } from "../src/utils/errors";
import { createHarness } from "./helpers";

describe("vault/data operations", () => {
  it("creates an empty vault", () => {
    expect(createEmptyVault()).toEqual({ version: 1, globals: {}, projects: {} });
  });

  it("adds projects and environments", () => {
    const vault = createEmptyVault();
    addProject(vault, "crono", "dev");
    expect(listProjects(vault)).toEqual(["crono"]);
    expect(listEnvironments(vault, "crono")).toEqual(["dev"]);
    expect(hasEnvironment(vault, "crono", "dev")).toBe(true);
    addProject(vault, "crono", "production");
    expect(listEnvironments(vault, "crono")).toEqual(["dev", "production"]);
  });

  it("adds environments to an existing project", () => {
    const vault = createEmptyVault();
    addProject(vault, "crono", "dev");
    expect(addEnvironment(vault, "crono", "production")).toBe(true);
    expect(addEnvironment(vault, "crono", "production")).toBe(false);
    expect(listEnvironments(vault, "crono")).toEqual(["dev", "production"]);
    expect(() => addEnvironment(vault, "crono", "bad name")).toThrow(ConfigError);
    expect(() => addEnvironment(vault, "missing", "dev")).toThrow();
  });

  it("rejects invalid project names", () => {
    const vault = createEmptyVault();
    expect(() => addProject(vault, "bad name")).toThrow(ConfigError);
  });

  it("removes projects", () => {
    const vault = createEmptyVault();
    addProject(vault, "crono", "dev");
    expect(removeProject(vault, "crono")).toBe(true);
    expect(removeProject(vault, "crono")).toBe(false);
    expect(listProjects(vault)).toEqual([]);
  });

  it("stores secrets in global, shared and environment scopes", () => {
    const vault = createEmptyVault();
    addProject(vault, "crono", "dev");

    setSecret(vault, { kind: "global" }, "GLOBAL", "g");
    setSecret(vault, { kind: "project", project: "crono" }, "SHARED", "s");
    setSecret(vault, { kind: "environment", project: "crono", environment: "dev" }, "ENV", "e");

    expect(getSecretEntry(vault, { kind: "global" }, "GLOBAL")?.value).toBe("g");
    expect(getSecretEntry(vault, { kind: "project", project: "crono" }, "SHARED")?.value).toBe("s");
    expect(
      getSecretEntry(vault, { kind: "environment", project: "crono", environment: "dev" }, "ENV")
        ?.value,
    ).toBe("e");
  });

  it("reports whether a secret was created or updated", () => {
    const vault = createEmptyVault();
    expect(setSecret(vault, { kind: "global" }, "A", "1").created).toBe(true);
    expect(setSecret(vault, { kind: "global" }, "A", "2").created).toBe(false);
    expect(getSecretEntry(vault, { kind: "global" }, "A")?.value).toBe("2");
  });

  it("refuses to write to a missing environment", () => {
    const vault = createEmptyVault();
    addProject(vault, "crono", "dev");
    expect(() =>
      setSecret(vault, { kind: "environment", project: "crono", environment: "nope" }, "A", "1"),
    ).toThrow(EnvironmentNotFoundError);
  });

  it("deletes secrets", () => {
    const vault = createEmptyVault();
    setSecret(vault, { kind: "global" }, "A", "1");
    expect(deleteSecret(vault, { kind: "global" }, "A")).toBe(true);
    expect(deleteSecret(vault, { kind: "global" }, "A")).toBe(false);
  });
});

describe("vault/validateVaultData", () => {
  it("rejects non-objects", () => {
    expect(() => validateVaultData(null)).toThrow(ConfigError);
    expect(() => validateVaultData([])).toThrow(ConfigError);
  });

  it("rejects corrupt secret entries", () => {
    expect(() => validateVaultData({ globals: { A: { value: 123 } } })).toThrow(ConfigError);
    expect(() => validateVaultData({ projects: { p: { shared: { A: "not-an-object" } } } })).toThrow(
      ConfigError,
    );
  });

  it("rejects a newer structure version", () => {
    expect(() => validateVaultData({ version: 99, globals: {}, projects: {} })).toThrow(ConfigError);
  });

  it("normalises a partial vault", () => {
    const normalised = validateVaultData({ globals: { A: { value: "1" } } });
    expect(normalised.version).toBe(1);
    expect(normalised.projects).toEqual({});
    expect(normalised.globals.A?.value).toBe("1");
  });
});

describe("vault/persistence", () => {
  it("round trips through the encrypted file", async () => {
    const harness = await createHarness();
    try {
      const vault = createEmptyVault();
      addProject(vault, "crono", "dev");
      setSecret(vault, { kind: "environment", project: "crono", environment: "dev" }, "TOKEN", "hunter2");
      await saveVault(harness.home, vault, harness.state.password);

      const loaded = await loadVault(harness.home, harness.state.password);
      expect(
        getSecretEntry(loaded, { kind: "environment", project: "crono", environment: "dev" }, "TOKEN")
          ?.value,
      ).toBe("hunter2");
    } finally {
      await harness.cleanup();
    }
  });

  it("fails to load with the wrong password", async () => {
    const harness = await createHarness();
    try {
      const vault = createEmptyVault();
      setSecret(vault, { kind: "global" }, "TOKEN", "hunter2");
      await saveVault(harness.home, vault, "right-password");
      await expect(loadVault(harness.home, "wrong-password")).rejects.toBeInstanceOf(
        WrongPasswordError,
      );
    } finally {
      await harness.cleanup();
    }
  });
});

describe("vault/stable salt", () => {
  it("reuses the salt across writes so a cached key stays valid", async () => {
    const harness = await createHarness();
    try {
      const vault = createEmptyVault();
      await saveVault(harness.home, vault, "stable-password");
      const first = JSON.parse(await readFile(join(harness.home, "vault.enc"), "utf8")) as {
        salt: string;
        iv: string;
      };

      setSecret(vault, { kind: "global" }, "A", "1");
      await saveVault(harness.home, vault, "stable-password");
      const second = JSON.parse(await readFile(join(harness.home, "vault.enc"), "utf8")) as {
        salt: string;
        iv: string;
      };

      expect(second.salt).toBe(first.salt);
      expect(second.iv).not.toBe(first.iv);
      const reloaded = await loadVault(harness.home, "stable-password");
      expect(reloaded.globals.A?.value).toBe("1");
    } finally {
      await harness.cleanup();
    }
  });

  it("saves and loads with an already-derived key", async () => {
    const harness = await createHarness();
    try {
      const vault = createEmptyVault();
      await saveVault(harness.home, vault, "derived-password");

      const envelope = JSON.parse(await readFile(join(harness.home, "vault.enc"), "utf8")) as {
        salt: string;
      };
      const salt = Buffer.from(envelope.salt, "base64");
      const key = await deriveKey("derived-password", salt);

      setSecret(vault, { kind: "global" }, "TOKEN", "value");
      await saveVaultWithKey(harness.home, vault, { key, salt });

      const loaded = await loadVaultWithKey(harness.home, key);
      expect(loaded.globals.TOKEN?.value).toBe("value");
    } finally {
      await harness.cleanup();
    }
  });
});
