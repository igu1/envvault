/**
 * `envvault tokens` — inspect and forget share tokens saved on this device.
 *
 * These are *client* credentials for reading someone else's shares, which is
 * the opposite end from `envvault share token`, where a vault owner issues
 * tokens. Tokens are never printed in full here: only a masked fingerprint.
 */

import { normaliseServerUrl } from "../server/client";
import { clearServerTokens, listServerTokens, maskToken, removeServerToken } from "../server/token-store";
import type { AppContext } from "../core/types";
import type { StoredToken } from "../server/token-store";
import type { ParsedArgs } from "../utils/args";
import { flagBool, requirePositional } from "../utils/args";
import { ExitCode, UsageError } from "../utils/errors";
import { formatSuccess, formatWarning, style } from "../utils/output";

export async function tokensCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const subcommand = args.positionals[0];
  switch (subcommand) {
    case undefined:
    case "list":
      return await listCommand(ctx);
    case "remove":
    case "rm":
      return await removeCommand(ctx, args);
    default:
      throw new UsageError(
        `Unknown tokens subcommand: ${subcommand}`,
        "Usage: envvault tokens <list|remove>",
      );
  }
}

async function listCommand(ctx: AppContext): Promise<number> {
  const tokens = await listServerTokens(ctx.home);
  const io = ctx.io;

  io.stdout(style.bold("Share tokens saved on this device"));
  io.stdout("");
  if (tokens.length === 0) {
    io.stdout("None yet.");
    io.stdout("");
    io.stdout("The first `envvault connect` to a server saves its token automatically.");
    return ExitCode.Success;
  }

  for (const entry of tokens) {
    const label = entry.label === undefined ? "" : `  (${entry.label})`;
    io.stdout(`${entry.url}`);
    io.stdout(`  ${maskToken(entry.token)}${label}  last used ${entry.lastUsedAt}`);
  }
  io.stdout("");
  io.stdout("Forget one with: envvault tokens remove <url>");
  return ExitCode.Success;
}

/** Best-effort host extraction for forgiving matching. */
function hostOf(value: string): string | null {
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
    return new URL(withScheme).host;
  } catch {
    return null;
  }
}

function matches(entry: StoredToken, input: string, normalised: string | null): boolean {
  if (entry.url === input) return true;
  if (normalised !== null && entry.url === normalised) return true;
  const host = hostOf(input);
  return host !== null && hostOf(entry.url) === host;
}

async function removeCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const io = ctx.io;

  if (flagBool(args.flags, "all")) {
    const removed = await clearServerTokens(ctx.home);
    io.stdout(formatSuccess(`Removed ${removed} saved token${removed === 1 ? "" : "s"}.`));
    return ExitCode.Success;
  }

  const input = requirePositional(
    args.positionals,
    1,
    "Usage: envvault tokens remove <url>   (or --all)",
  );

  let normalised: string | null = null;
  try {
    normalised = normaliseServerUrl(input);
  } catch {
    normalised = null;
  }

  const all = await listServerTokens(ctx.home);
  const targets = all.filter((entry) => matches(entry, input, normalised));
  if (targets.length === 0) {
    io.stderr(formatWarning(`No saved token for ${input}`));
    return ExitCode.Error;
  }

  let removed = 0;
  for (const url of new Set(targets.map((entry) => entry.url))) {
    removed += await removeServerToken(ctx.home, url);
  }
  io.stdout(formatSuccess(`Removed ${removed} saved token${removed === 1 ? "" : "s"} for ${input}.`));
  return ExitCode.Success;
}
