/**
 * Master-password acquisition and vault unlocking.
 *
 * The password is never written to disk. Non-interactive sources are supported
 * for automation, in this order:
 *
 *   1. ENVVAULT_MASTER_PASSWORD        (environment)
 *   2. ENVVAULT_MASTER_PASSWORD_FILE   (path to a 0600 file)
 *   3. piped stdin                     (only when stdin is a pipe)
 *   4. an active unlock session        (see `session.ts`)
 *   5. an interactive hidden prompt
 *
 * Commands that hand stdin to a child process (`run`, `docker`, `set --stdin`)
 * disable the pipe source so they never swallow the child's input.
 */

import { stat } from "node:fs/promises";

import { AuthError, VaultLockedError, VaultNotInitializedError } from "../utils/errors";
import { readTextFile } from "../utils/fs";
import { formatWarning } from "../utils/output";
import { decryptWithKey, deriveKey } from "./crypto";
import { clearSession, readSession } from "./session";
import { readEnvelopeFile, vaultExists } from "./storage";
import { parseVaultPlaintext } from "./vault";
import type { AppContext, EncryptedEnvelope, VaultData, VaultKey } from "./types";

export const MIN_MASTER_PASSWORD_LENGTH = 8;
export const MASTER_PASSWORD_FILE_VAR = "ENVVAULT_MASTER_PASSWORD_FILE";

export type UnlockSource = "password" | "environment" | "file" | "pipe" | "session";

export interface UnlockedVault {
  vault: VaultData;
  /** Derived key + salt, used to re-encrypt the vault on save. */
  key: VaultKey;
  source: UnlockSource;
}

export interface PasswordOptions {
  /** Ask for the password twice and require a match (used by `init`). */
  confirm?: boolean;
  /** Allow ENVVAULT_MASTER_PASSWORD / ENVVAULT_MASTER_PASSWORD_FILE. */
  allowEnv?: boolean;
  /** Allow reading the password from a pipe. Disable when stdin belongs to a child. */
  allowStdin?: boolean;
  /** Allow the interactive hidden prompt. Disable when another UI owns the terminal. */
  allowPrompt?: boolean;
}

export interface ResolvedPassword {
  password: string;
  source: "environment" | "file" | "pipe" | "prompt";
}

function trimTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

async function readPasswordFile(ctx: AppContext, path: string): Promise<string> {
  const content = await readTextFile(path);
  if (content === null) {
    throw new AuthError(`${MASTER_PASSWORD_FILE_VAR} points at a file that does not exist: ${path}`);
  }

  // Best-effort warning: a password file readable by other users weakens the
  // whole vault.
  try {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) {
      ctx.io.stderr(
        formatWarning(
          `password file ${path} is readable by other users (mode ${(info.mode & 0o777).toString(8)}); run chmod 600`,
        ),
      );
    }
  } catch {
    // Permission check is optional.
  }

  const password = trimTrailingNewline(content);
  if (password === "") throw new AuthError(`Password file is empty: ${path}`);
  return password;
}

/** Resolve a master password from the highest-priority available source. */
export async function resolvePassword(
  ctx: AppContext,
  options: PasswordOptions = {},
): Promise<ResolvedPassword> {
  const allowEnv = options.allowEnv !== false;

  const fromEnv = ctx.env.ENVVAULT_MASTER_PASSWORD;
  if (allowEnv && fromEnv !== undefined && fromEnv !== "") {
    return { password: fromEnv, source: "environment" };
  }

  const fromFile = ctx.env[MASTER_PASSWORD_FILE_VAR];
  if (allowEnv && fromFile !== undefined && fromFile !== "") {
    return { password: await readPasswordFile(ctx, fromFile), source: "file" };
  }

  if (options.allowPrompt !== false && ctx.io.stdinIsTTY) {
    const password = await ctx.io.promptHidden("Master password: ");
    if (options.confirm === true) {
      const confirmation = await ctx.io.promptHidden("Confirm master password: ");
      if (confirmation !== password) throw new AuthError("Passwords do not match.");
    }
    return { password, source: "prompt" };
  }

  if (options.allowStdin !== false) {
    const piped = trimTrailingNewline(await ctx.io.readStdin());
    if (piped !== "") return { password: piped, source: "pipe" };
  }

  throw new VaultLockedError();
}

export async function acquirePassword(
  ctx: AppContext,
  options: PasswordOptions = {},
): Promise<string> {
  return (await resolvePassword(ctx, options)).password;
}

/** Acquire and validate a new master password for `envvault init`. */
export async function acquireNewPassword(ctx: AppContext): Promise<string> {
  const { password } = await resolvePassword(ctx, { confirm: true });
  if (password.length < MIN_MASTER_PASSWORD_LENGTH) {
    throw new AuthError(
      `Master password must be at least ${MIN_MASTER_PASSWORD_LENGTH} characters.`,
    );
  }
  return password;
}

function hasExplicitCredential(ctx: AppContext): boolean {
  const fromEnv = ctx.env.ENVVAULT_MASTER_PASSWORD;
  const fromFile = ctx.env[MASTER_PASSWORD_FILE_VAR];
  return (fromEnv !== undefined && fromEnv !== "") || (fromFile !== undefined && fromFile !== "");
}

async function unlockWithPassword(
  ctx: AppContext,
  envelope: EncryptedEnvelope,
  options: { allowStdin: boolean; allowPrompt: boolean },
): Promise<UnlockedVault> {
  const { password, source } = await resolvePassword(ctx, {
    allowStdin: options.allowStdin,
    allowPrompt: options.allowPrompt,
  });
  const salt = Buffer.from(envelope.salt, "base64");
  const key = await deriveKey(password, salt);
  // Throws WrongPasswordError when the password is incorrect.
  const vault = parseVaultPlaintext(decryptWithKey(envelope, key));
  return {
    vault,
    key: { key, salt },
    source: source === "prompt" ? "password" : source,
  };
}

/** Unlock using a password the caller already holds (used by the interactive UI). */
export async function unlockWithPasswordValue(
  ctx: AppContext,
  password: string,
): Promise<UnlockedVault> {
  if (!(await vaultExists(ctx.home))) throw new VaultNotInitializedError();
  const envelope = await readEnvelopeFile(ctx.home);
  const salt = Buffer.from(envelope.salt, "base64");
  const key = await deriveKey(password, salt);
  // Throws WrongPasswordError when the password is incorrect.
  const vault = parseVaultPlaintext(decryptWithKey(envelope, key));
  return { vault, key: { key, salt }, source: "password" };
}

/** Authenticate with the master password, ignoring any unlock session. */
export async function unlockWithPrompt(ctx: AppContext): Promise<UnlockedVault> {
  if (!(await vaultExists(ctx.home))) throw new VaultNotInitializedError();
  const envelope = await readEnvelopeFile(ctx.home);
  return await unlockWithPassword(ctx, envelope, { allowStdin: true, allowPrompt: true });
}

export interface OpenVaultOptions {
  /**
   * Read the password from a pipe when stdin is not a terminal. Set to false
   * for commands that pass stdin to a child process.
   */
  allowStdinPassword?: boolean;
  /**
   * Show the interactive hidden prompt. Set to false when another UI (the TUI)
   * owns the terminal and will collect the password itself.
   */
  allowPromptPassword?: boolean;
}

/** Unlock the vault, preferring explicit credentials and then any session. */
export async function openVault(
  ctx: AppContext,
  options: OpenVaultOptions = {},
): Promise<UnlockedVault> {
  if (!(await vaultExists(ctx.home))) throw new VaultNotInitializedError();

  const envelope = await readEnvelopeFile(ctx.home);
  const salt = Buffer.from(envelope.salt, "base64");
  const allowStdin = options.allowStdinPassword !== false;
  const allowPrompt = options.allowPromptPassword !== false;

  if (hasExplicitCredential(ctx)) {
    return await unlockWithPassword(ctx, envelope, { allowStdin, allowPrompt });
  }

  // ENVVAULT_NO_SESSION forces authentication even when a session is active.
  if (ctx.env.ENVVAULT_NO_SESSION === undefined) {
    const session = await readSession(ctx.home);
    if (session !== null) {
      try {
        const vault = parseVaultPlaintext(decryptWithKey(envelope, session.key));
        return { vault, key: { key: session.key, salt }, source: "session" };
      } catch {
        // The cached key does not match this vault (for example after a
        // re-init); discard it and fall back to the password prompt.
        await clearSession(ctx.home);
      }
    }
  }

  return await unlockWithPassword(ctx, envelope, { allowStdin, allowPrompt });
}
