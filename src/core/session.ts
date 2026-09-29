/**
 * Unlock sessions.
 *
 * An unlock session caches the *derived* vault key — never the master password
 * — in `~/.envvault/session.json` (mode 0600) with an expiry, so commands like
 * `envvault run` do not prompt for every invocation.
 *
 * Trade-off: while a session is active, anyone who can read `session.json` as
 * your user can decrypt the vault without knowing the master password. That is
 * the same access level already required to read `vault.enc`. Keep the TTL
 * short, and clear the session with `envvault lock` (or set
 * `ENVVAULT_NO_SESSION=1`) when you do not want it.
 */

import { nowIso } from "./config";
import { vaultPaths } from "./storage";
import { CURRENT_VAULT_VERSION } from "./types";
import { pathExists, readJsonFile, removeFile, writeJsonAtomic } from "../utils/fs";

export interface VaultSession {
  key: Buffer;
  createdAt: string;
  expiresAt: string;
}

interface SessionFile {
  version: number;
  key: string;
  createdAt: string;
  expiresAt: string;
}

export const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
/** Sentinel expiry meaning "no expiry until `envvault lock`". */
export const SESSION_NEVER_EXPIRES = "never";

export function sessionPath(home: string): string {
  return vaultPaths(home).session;
}

/** Read a non-expired session, deleting the file when it is invalid or stale. */
export async function readSession(home: string): Promise<VaultSession | null> {
  let raw: SessionFile | null;
  try {
    raw = await readJsonFile<SessionFile>(sessionPath(home));
  } catch {
    // Corrupt session file: treat as absent rather than failing the command.
    await clearSession(home);
    return null;
  }
  if (raw === null) return null;

  const validShape =
    typeof raw.key === "string" &&
    typeof raw.createdAt === "string" &&
    typeof raw.expiresAt === "string";

  if (!validShape) {
    await clearSession(home);
    return null;
  }

  const expiresAt = raw.expiresAt;
  if (expiresAt !== SESSION_NEVER_EXPIRES) {
    const timestamp = Date.parse(expiresAt);
    if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
      await clearSession(home);
      return null;
    }
  }

  const key = Buffer.from(raw.key, "base64");
  if (key.length === 0) {
    await clearSession(home);
    return null;
  }

  return { key, createdAt: raw.createdAt, expiresAt: raw.expiresAt };
}

/** Persist the derived key for `ttlMs` and return the expiry timestamp. */
export async function writeSession(home: string, key: Buffer, ttlMs: number): Promise<string> {
  const createdAt = nowIso();
  const expiresAt =
    ttlMs === 0 ? SESSION_NEVER_EXPIRES : new Date(Date.now() + ttlMs).toISOString();
  const file: SessionFile = {
    version: CURRENT_VAULT_VERSION,
    key: key.toString("base64"),
    createdAt,
    expiresAt,
  };
  await writeJsonAtomic(sessionPath(home), file, 0o600);
  return expiresAt;
}

/** Remove the session file. Returns true when one existed. */
export async function clearSession(home: string): Promise<boolean> {
  const path = sessionPath(home);
  if (!(await pathExists(path))) return false;
  await removeFile(path);
  return true;
}
