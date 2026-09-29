/**
 * Encrypted vault backups.
 *
 * `envvault sync push` uploads the *encrypted* `vault.enc` envelope verbatim.
 * The server stores it as-is and can never read it: the backup keeps the same
 * master-password protection it has at rest. A backup id is a local namespace,
 * so one server can host several machines' vaults.
 */

import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { parseEnvelope } from "../core/crypto";
import { vaultPaths } from "../core/storage";
import { ServerConfigError } from "../utils/errors";
import { ensureDir, pathExists, readJsonFile, removeFile, writeJsonAtomic } from "../utils/fs";
import type { EncryptedEnvelope } from "../core/types";
import type { BackupInfo } from "./types";

const BACKUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const DEFAULT_BACKUP_ID = "default";
export const MAX_BACKUP_BYTES = 8 * 1024 * 1024;

export interface BackupFile {
  info: BackupInfo;
  envelope: EncryptedEnvelope;
}

export function isValidBackupId(id: string): boolean {
  return BACKUP_ID_PATTERN.test(id);
}

export function assertValidBackupId(id: string): void {
  if (!isValidBackupId(id)) {
    throw new ServerConfigError(
      `Invalid backup id: ${id}`,
      "Use letters, digits, dot, dash and underscore (max 64 characters).",
    );
  }
}

export function backupDir(home: string): string {
  return vaultPaths(home).backups;
}

export function backupFilePath(home: string, id: string): string {
  return join(backupDir(home), `${id}.json`);
}

export async function listBackups(home: string): Promise<BackupInfo[]> {
  const dir = backupDir(home);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const infos: BackupInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = await readJsonFile<BackupFile>(join(dir, entry));
    if (file?.info !== undefined) infos.push(file.info);
  }
  return infos.sort((a, b) => a.id.localeCompare(b.id));
}

export async function readBackup(home: string, id: string): Promise<BackupFile | null> {
  assertValidBackupId(id);
  return await readJsonFile<BackupFile>(backupFilePath(home, id));
}

/** Validate and persist an encrypted envelope. Returns its metadata. */
export async function writeBackup(
  home: string,
  id: string,
  rawEnvelope: unknown,
  uploadedAt: string,
): Promise<BackupInfo> {
  assertValidBackupId(id);
  // Re-validate so a malformed upload never reaches disk.
  const envelope = parseEnvelope(rawEnvelope);
  const serialised = JSON.stringify(envelope, null, 2);
  const bytes = Buffer.byteLength(serialised, "utf8");
  if (bytes > MAX_BACKUP_BYTES) {
    throw new ServerConfigError(
      `Backup too large: ${bytes} bytes (limit ${MAX_BACKUP_BYTES}).`,
    );
  }

  const info: BackupInfo = {
    id,
    uploadedAt,
    size: bytes,
    sha256: createHash("sha256").update(serialised).digest("hex"),
  };

  await ensureDir(backupDir(home));
  await writeJsonAtomic(backupFilePath(home, id), { info, envelope } satisfies BackupFile, 0o600);
  return info;
}

export async function deleteBackup(home: string, id: string): Promise<boolean> {
  assertValidBackupId(id);
  const path = backupFilePath(home, id);
  if (!(await pathExists(path))) return false;
  await removeFile(path);
  return true;
}
