import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** Permissions for files that may contain sensitive data. */
export const SECURE_FILE_MODE = 0o600;
/** Permissions for directories that contain sensitive data. */
export const SECURE_DIR_MODE = 0o700;

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string, mode: number = SECURE_DIR_MODE): Promise<void> {
  await mkdir(dir, { recursive: true, mode });
}

export async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  const text = await readTextFile(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}`, { cause: error });
  }
}

/**
 * Atomically write a JSON document.
 *
 * We write to a temporary file in the same directory, fsync it, then rename
 * over the target. A crash mid-write can never produce a truncated file, and
 * the previous contents remain readable until the rename succeeds.
 */
export async function writeJsonAtomic(
  path: string,
  value: unknown,
  mode: number = SECURE_FILE_MODE,
): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  mode: number = SECURE_FILE_MODE,
): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(tmp, "w", mode);
  try {
    await handle.writeFile(data);
    // Best-effort durability: ignore ENOTSUP on filesystems without fsync.
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
  // `open` only applies `mode` at creation time and is subject to umask.
  await chmod(tmp, mode).catch(() => undefined);
  try {
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
