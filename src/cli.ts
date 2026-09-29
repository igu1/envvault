#!/usr/bin/env node
/**
 * EnvVault CLI entry point.
 *
 * This module is intentionally thin: it parses the root command, delegates to
 * a command module, and turns errors into readable output plus exit codes.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { copyCommand } from "./commands/copy";
import { connectCommand } from "./commands/connect";
import { deleteCommand } from "./commands/delete";
import { dockerCommand } from "./commands/docker";
import { doctorCommand } from "./commands/doctor";
import { exportCommand } from "./commands/export";
import { getCommand } from "./commands/get";
import { importCommand } from "./commands/import";
import { initCommand } from "./commands/init";
import { listCommand } from "./commands/list";
import { lockCommand } from "./commands/lock";
import { projectCommand } from "./commands/project";
import { runCommand } from "./commands/run";
import { serveCommand } from "./commands/serve";
import { serverCommand } from "./commands/server";
import { setCommand } from "./commands/set";
import { shareCommand } from "./commands/share";
import { syncCommand } from "./commands/sync";
import { unlockCommand } from "./commands/unlock";
import { unuseCommand } from "./commands/unuse";
import { uiCommand } from "./commands/ui";
import { useCommand } from "./commands/use";
import { createAppContext, VERSION } from "./core/config";
import type { AppContext } from "./core/types";
import { parseArgs } from "./utils/args";
import { EnvVaultError, ExitCode, UsageError } from "./utils/errors";

const HELP = `EnvVault

One encrypted vault for every project.

Usage:
  envvault <command>

Commands:
  init                 Initialize EnvVault
  unlock               Unlock once so commands stop prompting
  lock                 Clear the cached unlock session
  project              Manage projects
  use                  Bind this directory to a project/environment
  unuse                Disconnect this directory from its project
  set                  Store a secret
  get                  Read a secret
  list                 List available secret names
  delete               Delete a secret
  import               Import a .env file
  export               Export secrets
  run                  Run a command with injected secrets
  copy                 Copy a secret to clipboard
  doctor               Check project environment configuration
  ui                   Interactive terminal UI
  docker               Docker and Docker Compose integration

Sharing:
  server               Enable and configure the sharing server
  share                Manage shared environments and access tokens
  serve                Run the sharing server (opt-in)
  connect              Pull shared keys from another vault
  sync                 Push or pull an encrypted vault backup

Examples:
  envvault init
  envvault use crono/dev
  envvault set DATABASE_URL
  envvault run -- npm run dev
  envvault docker compose up
  envvault share add crono/dev --keys DATABASE_URL
  envvault share token create --label laptop --shares all
  envvault serve
  envvault connect http://192.168.1.10:8787 --token <token>`;

/** Flags that never consume a following value. */
const BOOLEAN_FLAGS = [
  "global",
  "shared",
  "stdin",
  "reveal",
  "raw",
  "yes",
  "overwrite",
  "origins",
  "environments",
  "strict",
  "json",
  "quiet",
  "verbose",
  "clear",
  "help",
  "version",
  "list",
  "dry-run",
  "all",
  "backup",
] as const;

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  ctx: AppContext = createAppContext(),
): Promise<number> {
  try {
    return await dispatch(ctx, [...argv]);
  } catch (error) {
    return handleError(ctx, error);
  }
}

async function dispatch(ctx: AppContext, argv: string[]): Promise<number> {
  const command = argv[0];
  const rest = argv.slice(1);

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    ctx.io.stdout(HELP);
    return ExitCode.Success;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    ctx.io.stdout(`envvault ${VERSION}`);
    return ExitCode.Success;
  }

  switch (command) {
    case "init":
      return await initCommand(ctx, parseArgs(rest, BOOLEAN_FLAGS));
    case "unlock":
      return await unlockCommand(ctx, parseArgs(rest, BOOLEAN_FLAGS));
    case "lock":
      return await lockCommand(ctx);
    case "project":
      return await projectCommand(ctx, parseArgs(rest, BOOLEAN_FLAGS));
    case "use":
      return await useCommand(ctx, parseArgs(rest, BOOLEAN_FLAGS));
    case "unuse":
      return await unuseCommand(ctx, parseArgs(rest, BOOLEAN_FLAGS));
    case "set":
      return await setCommand(ctx, parseArgs(rest, BOOLEAN_FLAGS));
    case "get":
      return await getCommand(ctx, parseArgs(rest, BOOLEAN_FLAGS));
    case "list":
      return await listCommand(ctx, parseArgs(rest, BOOLEAN_FLAGS));
    case "delete":
    case "rm":
      return await deleteCommand(ctx, parseArgs(rest, BOOLEAN_FLAGS));
    case "import":
      return await importCommand(ctx, parseArgs(rest, BOOLEAN_FLAGS));
    case "export":
      return await exportCommand(ctx, parseArgs(rest, BOOLEAN_FLAGS));
    case "run":
      return await runCommand(ctx, rest);
    case "copy":
      return await copyCommand(ctx, parseArgs(rest, BOOLEAN_FLAGS));
    case "doctor":
      return await doctorCommand(ctx, parseArgs(rest, BOOLEAN_FLAGS));
    case "ui":
      return await uiCommand(ctx, parseArgs(rest, BOOLEAN_FLAGS));
    case "docker":
      return await dockerCommand(ctx, rest);
    case "server":
      return await serverCommand(ctx, parseArgs(rest, BOOLEAN_FLAGS));
    case "share":
      return await shareCommand(ctx, parseArgs(rest, BOOLEAN_FLAGS));
    case "serve":
      return await serveCommand(ctx, parseArgs(rest, BOOLEAN_FLAGS));
    case "connect":
      return await connectCommand(ctx, parseArgs(rest, BOOLEAN_FLAGS));
    case "sync":
      return await syncCommand(ctx, parseArgs(rest, BOOLEAN_FLAGS));
    default:
      throw new UsageError(
        `Unknown command: ${command}`,
        "Run `envvault --help` to see available commands.",
      );
  }
}

function handleError(ctx: AppContext, error: unknown): number {
  if (error instanceof EnvVaultError) {
    ctx.io.stderr(error.message);
    if (error.hint !== undefined) {
      ctx.io.stderr("");
      ctx.io.stderr(error.hint);
    }
    return error.exitCode;
  }

  const message = error instanceof Error ? error.message : String(error);
  ctx.io.stderr(`Unexpected error: ${message}`);
  if (process.env.ENVVAULT_DEBUG !== undefined && error instanceof Error && error.stack) {
    ctx.io.stderr("");
    ctx.io.stderr(error.stack);
  }
  return ExitCode.Error;
}

const isDirectRun = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`Unexpected error: ${String(error)}\n`);
      process.exitCode = ExitCode.Error;
    });
}
