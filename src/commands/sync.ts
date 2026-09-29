/**
 * `envvault sync` — move the encrypted vault between machines through a
 * self-hosted server.
 *
 * Backups are the raw `vault.enc` envelope: the server stores opaque
 * ciphertext it cannot read, and pulling restores that envelope verbatim. This
 * is the "encrypted backup/sync" half of the sharing server and pairs with the
 * selective, decryptable shares served from `/shares`.
 */

import { displayHome } from "../core/config";
import { readEnvelopeFile, vaultExists, writeEnvelopeFile } from "../core/storage";
import { clearSession } from "../core/session";
import { parseEnvelope } from "../core/crypto";
import {
  downloadRemoteBackup,
  deleteRemoteBackup,
  listRemoteBackups,
  normaliseServerUrl,
  uploadRemoteBackup,
} from "../server/client";
import { DEFAULT_BACKUP_ID, assertValidBackupId } from "../server/backup";
import { notifyTokenSaved, rememberShareToken, resolveShareToken, staleTokenHint } from "./share-token";
import { readTextFile, writeFileAtomic } from "../utils/fs";
import type { AppContext } from "../core/types";
import type { ParsedArgs } from "../utils/args";
import { flagBool, flagString, requirePositional } from "../utils/args";
import { ExitCode, ShareAuthError, UsageError } from "../utils/errors";
import { formatSuccess, formatWarning, style } from "../utils/output";

export async function syncCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const subcommand = args.positionals[0];
  switch (subcommand) {
    case "list":
      return await listCommand(ctx, args);
    case "push":
      return await pushCommand(ctx, args);
    case "pull":
      return await pullCommand(ctx, args);
    case "remove":
    case "rm":
      return await removeCommand(ctx, args);
    default:
      throw new UsageError(
        subcommand === undefined
          ? "Missing sync subcommand."
          : `Unknown sync subcommand: ${subcommand}`,
        "Usage: envvault sync <list|push|pull|remove> <url> --token <token> [--id <name>]",
      );
  }
}

interface SyncTarget {
  baseUrl: string;
  token: string;
  id: string;
}

async function resolveTarget(ctx: AppContext, args: ParsedArgs): Promise<SyncTarget> {
  const url = requirePositional(
    args.positionals,
    1,
    "Usage: envvault sync <list|push|pull|remove> <url> --token <token> [--id <name>]",
  );
  const baseUrl = normaliseServerUrl(url);
  const { token } = await resolveShareToken(ctx, args, baseUrl);
  const id = flagString(args.flags, "id") ?? DEFAULT_BACKUP_ID;
  assertValidBackupId(id);
  return { baseUrl, token, id };
}

/**
 * Run a server call, remember the token once it is proven to work, and add a
 * hint when a saved token turns out to be stale.
 */
async function withToken<T>(
  ctx: AppContext,
  args: ParsedArgs,
  target: SyncTarget,
  run: () => Promise<T>,
): Promise<T> {
  try {
    const value = await run();
    const remembered = await rememberShareToken(ctx, args, target.baseUrl, target.token);
    notifyTokenSaved(ctx, target.baseUrl, remembered);
    return value;
  } catch (error) {
    if (error instanceof ShareAuthError) {
      throw new ShareAuthError(error.message, staleTokenHint(ctx, target.baseUrl));
    }
    throw error;
  }
}

async function listCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const target = await resolveTarget(ctx, args);
  const backups = await withToken(ctx, args, target, () =>
    listRemoteBackups(target.baseUrl, target.token),
  );
  const io = ctx.io;
  io.stdout(style.bold(`Backups on ${target.baseUrl}`));
  io.stdout("");
  if (backups.length === 0) {
    io.stdout("No backups yet.");
    return ExitCode.Success;
  }
  for (const backup of backups) {
    io.stdout(`${backup.id}  ${backup.size} bytes  ${backup.uploadedAt}  sha256:${backup.sha256.slice(0, 12)}`);
  }
  return ExitCode.Success;
}

async function pushCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const target = await resolveTarget(ctx, args);
  if (!(await vaultExists(ctx.home))) {
    ctx.io.stderr(formatWarning("There is no vault to push."));
    return ExitCode.Error;
  }

  const envelope = await readEnvelopeFile(ctx.home);
  const info = await withToken(ctx, args, target, () =>
    uploadRemoteBackup(target.baseUrl, target.token, target.id, envelope),
  );

  ctx.io.stdout(
    formatSuccess(
      `Pushed ${displayHome(ctx.home, ctx.env)} to ${target.baseUrl} as "${info.id}"`,
    ),
  );
  ctx.io.stdout(`Uploaded ${info.size} bytes (encrypted).`);
  return ExitCode.Success;
}

async function pullCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const target = await resolveTarget(ctx, args);
  const { envelope, info } = await withToken(ctx, args, target, () =>
    downloadRemoteBackup(target.baseUrl, target.token, target.id),
  );
  // Validate before touching the local vault.
  parseEnvelope(envelope);

  const io = ctx.io;
  io.stdout(`Backup "${info.id}" from ${target.baseUrl}`);
  io.stdout(`${info.size} bytes, uploaded ${info.uploadedAt}`);

  if (!flagBool(args.flags, "yes")) {
    const confirmed = await ctx.io.confirm(
      "Replace the local vault with this backup? The current vault.enc is kept as a .bak file.",
      false,
    );
    if (!confirmed) {
      io.stdout("Aborted.");
      return ExitCode.Success;
    }
  }

  const backupPath = await backupExistingVault(ctx);
  await writeEnvelopeFile(ctx.home, envelope);
  await clearSession(ctx.home);

  io.stdout("");
  io.stdout(formatSuccess("Local vault replaced"));
  if (backupPath !== null) io.stdout(`Previous vault saved to ${displayHome(backupPath, ctx.env)}`);
  io.stdout("The next command may ask for the master password of the restored vault.");
  return ExitCode.Success;
}

async function backupExistingVault(ctx: AppContext): Promise<string | null> {
  const path = `${ctx.home}/vault.enc`;
  const existing = await readTextFile(path);
  if (existing === null) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${path}.bak-${stamp}`;
  await writeFileAtomic(target, existing, 0o600);
  return target;
}

async function removeCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const target = await resolveTarget(ctx, args);
  await withToken(ctx, args, target, () =>
    deleteRemoteBackup(target.baseUrl, target.token, target.id),
  );
  ctx.io.stdout(formatSuccess(`Deleted backup "${target.id}" on ${target.baseUrl}`));
  return ExitCode.Success;
}
