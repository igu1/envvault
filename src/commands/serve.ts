/**
 * `envvault serve` — run the opt-in sharing server in the foreground.
 *
 * The server is only started when sharing has been explicitly enabled, so a
 * default install never opens a socket. The vault is unlocked once (session,
 * password or env var) and the derived key is kept in memory; the encrypted
 * file is re-read per request, so edits are reflected without a restart.
 */

import { VERSION, displayHome } from "../core/config";
import { openVault } from "../core/unlock";
import { readServerConfig } from "../server/config";
import { isLoopback, isWildcard, localNetworkAddresses } from "../server/net";
import { startShareServer } from "../server/service";
import type { AppContext } from "../core/types";
import type { ParsedArgs } from "../utils/args";
import { flagNumber, flagString } from "../utils/args";
import { ExitCode, ServerDisabledError } from "../utils/errors";
import { formatSuccess, formatWarning, style } from "../utils/output";

export async function serveCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const config = await readServerConfig(ctx.home);
  if (!config.enabled) throw new ServerDisabledError();

  const host = flagString(args.flags, "host");
  const port = flagNumber(args.flags, "port");
  if (config.tokens.length === 0) {
    ctx.io.stderr(
      formatWarning(
        "no share tokens exist yet, so nobody can connect until you create one with `envvault share token create --label <name>`",
      ),
    );
  }

  // Unlock before binding so a wrong password fails without opening a port.
  const { key } = await openVault(ctx, { allowStdinPassword: true, allowPromptPassword: true });

  const running = await startShareServer({
    home: ctx.home,
    config,
    vaultKey: key.key,
    version: VERSION,
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    onLog: (line) => {
      ctx.io.stderr(`[serve] ${line}`);
    },
  });

  notifyStarted(ctx, running.urls, running.port, config.host, config.shares.length, config.tokens.length);

  await waitForShutdown();
  await running.close();
  ctx.io.stdout("");
  ctx.io.stdout("Sharing server stopped.");
  return ExitCode.Success;
}

function notifyStarted(
  ctx: AppContext,
  urls: string[],
  port: number,
  configuredHost: string,
  shareCount: number,
  tokenCount: number,
): void {
  const io = ctx.io;
  io.stdout(style.bold("EnvVault sharing server"));
  io.stdout("");
  io.stdout(formatSuccess(`Listening on ${urls.join(", ")}`));
  io.stdout(`Vault          ${displayHome(ctx.home, ctx.env)}`);
  io.stdout(`Shares         ${shareCount}`);
  io.stdout(`Tokens         ${tokenCount}`);

  const lanUrls = isWildcard(configuredHost)
    ? localNetworkAddresses().map((address) => `http://${address}:${port}`)
    : [];
  if (lanUrls.length > 0) {
    io.stdout("");
    io.stdout("Reachable on this machine's network as:");
    for (const url of lanUrls) io.stdout(`  ${url}`);
  }

  io.stdout("");
  io.stdout("Connect from another machine with:");
  io.stdout("");
  io.stdout(`  envvault connect ${lanUrls[0] ?? urls[0] ?? "http://<host>:<port>"} --token <token>`);
  io.stdout("");
  io.stdout("Press Ctrl+C to stop.");

  if (!isLoopback(configuredHost)) {
    io.stderr("");
    io.stderr(
      formatWarning(
        `bound to ${configuredHost}: this is reachable from other machines on the network.`,
      ),
    );
  }
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}
