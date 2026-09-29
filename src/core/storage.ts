import { join } from "node:path";

import { parseEnvelope } from "./crypto";
import { CURRENT_VAULT_VERSION } from "./types";
import type {
  ContextsFile,
  EncryptedEnvelope,
  EnvVaultConfig,
  MetadataFile,
} from "./types";
import {
  ensureDir,
  pathExists,
  readJsonFile,
  writeJsonAtomic,
  writeFileAtomic,
} from "../utils/fs";

/** Canonical file locations inside the EnvVault home directory. */
export interface VaultPaths {
  dir: string;
  vault: string;
  config: string;
  contexts: string;
  metadata: string;
  session: string;
  server: string;
  backups: string;
  tokens: string;
}

export function vaultPaths(home: string): VaultPaths {
  return {
    dir: home,
    vault: join(home, "vault.enc"),
    config: join(home, "config.json"),
    contexts: join(home, "contexts.json"),
    metadata: join(home, "metadata.json"),
    session: join(home, "session.json"),
    server: join(home, "server.json"),
    backups: join(home, "backups"),
    tokens: join(home, "share-tokens.json"),
  };
}

export async function ensureVaultDir(home: string): Promise<void> {
  await ensureDir(home, 0o700);
}

export async function vaultExists(home: string): Promise<boolean> {
  return await pathExists(vaultPaths(home).vault);
}

/** Read and validate the encrypted envelope. Throws on malformed files. */
export async function readEnvelopeFile(home: string): Promise<EncryptedEnvelope> {
  const raw = await readJsonFile<unknown>(vaultPaths(home).vault);
  return parseEnvelope(raw);
}

export async function writeEnvelopeFile(
  home: string,
  envelope: EncryptedEnvelope,
): Promise<void> {
  await ensureVaultDir(home);
  // Atomic write: a failure here leaves the previous vault intact.
  await writeFileAtomic(
    vaultPaths(home).vault,
    `${JSON.stringify(envelope, null, 2)}\n`,
    0o600,
  );
}

export async function readConfigFile(home: string): Promise<EnvVaultConfig | null> {
  return await readJsonFile<EnvVaultConfig>(vaultPaths(home).config);
}

export async function writeConfigFile(home: string, config: EnvVaultConfig): Promise<void> {
  await writeJsonAtomic(vaultPaths(home).config, config, 0o600);
}

export async function readContextsFile(home: string): Promise<ContextsFile> {
  const file = await readJsonFile<ContextsFile>(vaultPaths(home).contexts);
  if (file === null || typeof file.contexts !== "object" || file.contexts === null) {
    return { version: CURRENT_VAULT_VERSION, contexts: {} };
  }
  return { version: file.version ?? CURRENT_VAULT_VERSION, contexts: file.contexts };
}

export async function writeContextsFile(home: string, contexts: ContextsFile): Promise<void> {
  await writeJsonAtomic(vaultPaths(home).contexts, contexts, 0o600);
}

export async function readMetadataFile(home: string): Promise<MetadataFile | null> {
  return await readJsonFile<MetadataFile>(vaultPaths(home).metadata);
}

export async function writeMetadataFile(home: string, metadata: MetadataFile): Promise<void> {
  await writeJsonAtomic(vaultPaths(home).metadata, metadata, 0o600);
}
