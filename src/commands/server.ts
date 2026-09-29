/**
 * `envvault server` — inspect and change sharing settings.
 *
 * Enabling sharing never opens a socket by itself; it only flips the switch
 * that `envvault serve` checks. This keeps a default install quiet and makes
 * "only if enabled" an explicit, auditable action.
 */

import { readServerConfig } from "../server/config";
import {
  describeGrant,
  listShares,
  listTokens,
  setServerBinding,
  setServerEnabled,
} from "../server/manage";
import { isLoopback, isWildcard, localNetworkAddresses } from "../server/net";
import { fetchHealth } from "../server/client";
import type { AppContext } from "../core/types";
import type { ServerConfig } from "../server/types";
import type { ParsedArgs } from "../utils/args";
import { requirePositional } from "../utils/args";
import { ExitCode, UsageError } from "../utils/errors";
import { formatSuccess, formatWarning, style } from "../utils/output";

export async function serverCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const subcommand = args.positionals[0];
  switch (subcommand) {
    case undefined:
    case "status":
      return await statusCommand(ctx, args);
    case "enable":
      return await setEnabledCommand(ctx, true);
    case "disable":
      return await setEnabledCommand(ctx, false);
    case "host":
      return await hostCommand(ctx, args);
    case "port":
      return await portCommand(ctx, args);
    default:
      throw new UsageError(
        `Unknown server subcommand: ${subcommand}`,
        "Usage: envvault server <status|enable|disable|host|port>",
      );
  }
}

async function statusCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const config = await readServerConfig(ctx.home);
  const io = ctx.io;

  io.stdout(style.bold("Sharing server"));
  io.stdout("");
  io.stdout(`Enabled        ${config.enabled ? "yes" : "no"}`);
  io.stdout(`Address        ${config.host}:${config.port}`);
  io.stdout(`Shares         ${config.shares.length}`);
  io.stdout(`Tokens         ${config.tokens.length}`);

  if (config.enabled) {
    const reachable = await probe(config);
    io.stdout(`Running        ${reachable ? "yes" : "no"}`);
    if (!reachable) io.stdout("Start it with: envvault serve");
  }

  if (config.host !== undefined && !isLoopback(config.host)) {
    io.stderr("");
    io.stderr(formatWarning(`${config.host} is reachable from other machines.`));
  }
  if (config.shares.length === 0) {
    io.stdout("");
    io.stdout("No shares yet. Create one with:");
    io.stdout("");
    io.stdout("  envvault share add <project>/<environment> --keys NAME[,NAME...]");
  }
  return ExitCode.Success;
}

/** Best-effort liveness probe. Never throws and never blocks the command. */
async function probe(config: ServerConfig): Promise<boolean> {
  const host = isWildcard(config.host) ? "127.0.0.1" : config.host;
  try {
    await fetchHealth(`http://${host}:${config.port}`, 500);
    return true;
  } catch {
    return false;
  }
}

async function setEnabledCommand(ctx: AppContext, enabled: boolean): Promise<number> {
  const config = await setServerEnabled(ctx.home, enabled);
  const io = ctx.io;

  if (enabled) {
    io.stdout(formatSuccess("Sharing enabled"));
    io.stdout("");
    io.stdout("The server is not running yet. Start it with:");
    io.stdout("");
    io.stdout("  envvault serve");
    io.stdout("");
    io.stdout(`It will listen on ${config.host}:${config.port}.`);
    if (!isLoopback(config.host)) {
      io.stderr(
        formatWarning(`${config.host} is reachable from other machines on the network.`),
      );
      const addresses = localNetworkAddresses();
      if (addresses.length > 0) {
        io.stderr(`Local addresses: ${addresses.join(", ")}`);
      }
    }
  } else {
    io.stdout(formatSuccess("Sharing disabled"));
    io.stdout("Stop a running server with Ctrl+C, then it will refuse to start again.");
  }
  return ExitCode.Success;
}

async function hostCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const value = requirePositional(
    args.positionals,
    1,
    "Usage: envvault server host <address>   (for example 127.0.0.1 or 0.0.0.0)",
  );
  const config = await setServerBinding(ctx.home, { host: value });
  ctx.io.stdout(formatSuccess(`Bind address set to ${config.host}`));

  if (!isLoopback(config.host)) {
    ctx.io.stderr("");
    ctx.io.stderr(
      formatWarning(
        `${config.host} exposes the server to your network. Share tokens are the only thing protecting it.`,
      ),
    );
    const addresses = localNetworkAddresses();
    if (addresses.length > 0) {
      ctx.io.stderr(`Local addresses: ${addresses.join(", ")}`);
    }
  }
  return ExitCode.Success;
}

async function portCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const raw = requirePositional(args.positionals, 1, "Usage: envvault server port <number>");
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(`Invalid port: ${raw}`, "Use a number between 0 and 65535.");
  }
  const config = await setServerBinding(ctx.home, { port });
  ctx.io.stdout(formatSuccess(`Port set to ${config.port}`));
  return ExitCode.Success;
}

/** Used by the UI to render the settings summary in one place. */
export async function serverSummary(home: string): Promise<{
  config: ServerConfig;
  shares: number;
  tokens: number;
  grants: string[];
}> {
  const config = await readServerConfig(home);
  const [shares, tokens] = await Promise.all([listShares(home), listTokens(home)]);
  return {
    config,
    shares: shares.length,
    tokens: tokens.length,
    grants: tokens.map((token) => `${token.label}: ${describeGrant(token.grant)}`),
  };
}
