/**
 * `envvault share` — manage what is exposed and who can read it.
 *
 * Shares reference secret *names*; tokens are shown once and stored only as a
 * derived key. Both operations write `~/.envvault/server.json` atomically.
 */

import { openVault } from "../core/unlock";
import { assertEnvironment, assertProject } from "../core/vault";
import {
  describeGrant,
  createShareToken,
  listShares,
  listTokens,
  missingShareKeys,
  removeShare,
  revokeShareToken,
  upsertShare,
} from "../server/manage";
import { parseShareRef, shareRef } from "../server/types";
import { writeFileAtomic } from "../utils/fs";
import type { AppContext } from "../core/types";
import type { ShareDefinition, TokenGrant } from "../server/types";
import type { ParsedArgs } from "../utils/args";
import { flagBool, flagList, flagString, requirePositional } from "../utils/args";
import { ExitCode, UsageError } from "../utils/errors";
import { formatSuccess, formatWarning, style } from "../utils/output";

export async function shareCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const [subcommand, sub2] = args.positionals;
  switch (subcommand) {
    case undefined:
    case "list":
      return await listCommand(ctx);
    case "add":
      return await addCommand(ctx, args);
    case "remove":
    case "rm":
      return await removeCommand(ctx, args);
    case "token":
      return await tokenCommand(ctx, args, sub2);
    default:
      throw new UsageError(
        `Unknown share subcommand: ${subcommand}`,
        "Usage: envvault share <list|add|remove|token>",
      );
  }
}

function shareLine(share: ShareDefinition): string {
  const label = share.label === undefined ? "" : `  (${share.label})`;
  return `${shareRef(share.project, share.environment)}${label}  →  ${share.keys.join(", ")}`;
}

async function listCommand(ctx: AppContext): Promise<number> {
  const shares = await listShares(ctx.home);
  const io = ctx.io;
  io.stdout(style.bold("Shared environments"));
  io.stdout("");
  if (shares.length === 0) {
    io.stdout("Nothing is shared.");
    io.stdout("");
    io.stdout("Add a share with:");
    io.stdout("");
    io.stdout("  envvault share add <project>/<environment> --keys NAME[,NAME...]");
    return ExitCode.Success;
  }
  for (const share of shares) io.stdout(shareLine(share));
  return ExitCode.Success;
}

function requireRef(ctx: AppContext, args: ParsedArgs): { project: string; environment: string } {
  const reference = requirePositional(
    args.positionals,
    1,
    "Usage: envvault share add <project>/<environment> --keys NAME[,NAME...]",
  );
  const ref = parseShareRef(reference);
  if (ref === null) {
    throw new UsageError(
      `Invalid share reference: ${reference}`,
      "Use the form project/environment, for example crono/dev.",
    );
  }
  return ref;
}

async function addCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const { project, environment } = requireRef(ctx, args);
  const keys = flagList(args.flags, "keys");
  if (keys.length === 0) {
    throw new UsageError(
      "A share needs at least one key.",
      `List the keys with \`envvault list --project ${project} --env ${environment}\`, then pass --keys NAME[,NAME...].`,
    );
  }

  const { vault } = await openVault(ctx);
  assertProject(vault, project);
  assertEnvironment(vault, project, environment);

  const label = flagString(args.flags, "label");
  const missing = missingShareKeys(vault, project, environment, keys);
  const { share, created } = await upsertShare(ctx.home, {
    project,
    environment,
    keys,
    ...(label === undefined ? {} : { label }),
  });

  ctx.io.stdout(
    formatSuccess(
      `${created ? "Sharing" : "Updated share for"} ${shareRef(project, environment)} (${share.keys.length} key(s))`,
    ),
  );
  if (missing.length > 0) {
    ctx.io.stderr(
      formatWarning(
        `not currently in ${shareRef(project, environment)}: ${missing.join(", ")}`,
      ),
    );
  }
  return ExitCode.Success;
}

async function removeCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const { project, environment } = requireRef(ctx, args);
  const removed = await removeShare(ctx.home, project, environment);
  if (!removed) {
    ctx.io.stderr(formatWarning(`No share for ${shareRef(project, environment)}`));
    return ExitCode.Error;
  }
  ctx.io.stdout(formatSuccess(`Stopped sharing ${shareRef(project, environment)}`));
  return ExitCode.Success;
}

async function tokenCommand(
  ctx: AppContext,
  args: ParsedArgs,
  sub2: string | undefined,
): Promise<number> {
  switch (sub2) {
    case undefined:
    case "list":
      return await tokenListCommand(ctx);
    case "create":
      return await tokenCreateCommand(ctx, args);
    case "revoke":
    case "rm":
      return await tokenRevokeCommand(ctx, args);
    default:
      throw new UsageError(
        `Unknown token subcommand: ${sub2}`,
        "Usage: envvault share token <list|create|revoke>",
      );
  }
}

async function tokenListCommand(ctx: AppContext): Promise<number> {
  const tokens = await listTokens(ctx.home);
  const io = ctx.io;
  io.stdout(style.bold("Share tokens"));
  io.stdout("");
  if (tokens.length === 0) {
    io.stdout("No tokens. Nobody can connect yet.");
    io.stdout("");
    io.stdout("Create one with:");
    io.stdout("");
    io.stdout("  envvault share token create --label laptop --shares all");
    return ExitCode.Success;
  }
  for (const token of tokens) {
    io.stdout(`${token.id}  ${token.label}  [${describeGrant(token.grant)}]  ${token.createdAt}`);
  }
  io.stdout("");
  io.stdout("Tokens are shown only once at creation; revoke with `envvault share token revoke <id>`.");
  return ExitCode.Success;
}

async function tokenCreateCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const label = flagString(args.flags, "label");
  if (label === undefined || label.trim() === "") {
    throw new UsageError(
      "A token label is required.",
      "Usage: envvault share token create --label <name> [--shares all|<project>/<env>,...] [--backup]",
    );
  }

  const shareRefs = flagList(args.flags, "shares");
  const wantsAll =
    flagBool(args.flags, "all") ||
    shareRefs.length === 0 ||
    (shareRefs.length === 1 && shareRefs[0] === "all");
  const grant: TokenGrant = {
    shares: wantsAll ? "all" : shareRefs,
    backup: flagBool(args.flags, "backup"),
  };

  const { token, record } = await createShareToken(ctx.home, label.trim(), grant);
  const out = flagString(args.flags, "out");

  const io = ctx.io;
  io.stdout(formatSuccess(`Created token ${record.id} (${record.label})`));
  io.stdout(`Access: ${describeGrant(grant)}`);

  if (out !== undefined) {
    await writeFileAtomic(out, `${token}\n`, 0o600);
    io.stdout("");
    io.stdout(formatSuccess(`Token stored in ${out} (mode 0600)`));
    io.stdout("Give that file to whoever should connect.");
  } else {
    io.stdout("");
    io.stdout(style.bold("Share token (shown once)"));
    io.stdout("");
    io.stdout(`  ${token}`);
    io.stdout("");
    io.stdout("This is the only time it is displayed. The server stores a derived key, not the token.");
  }
  return ExitCode.Success;
}

async function tokenRevokeCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const id = requirePositional(
    args.positionals,
    2,
    "Usage: envvault share token revoke <id>",
  );
  const removed = await revokeShareToken(ctx.home, id);
  if (!removed) {
    ctx.io.stderr(formatWarning(`No token with id: ${id}`));
    return ExitCode.Error;
  }
  ctx.io.stdout(formatSuccess(`Revoked token ${id}`));
  return ExitCode.Success;
}
