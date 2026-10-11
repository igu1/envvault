/**
 * `envvault remote <url> <command>`
 *
 * Reads and changes the vault on a sharing server instead of this device. The
 * server must have been granted remote control for the token. Token resolution
 * matches `connect` and `sync` (flag, ENVVAULT_SHARE_TOKEN, saved token, prompt).
 *
 * A remote vault has no directory context, so every secret command needs an
 * explicit scope: `--global`, or `--project <name>` with `--env <name>` or
 * `--shared`.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { isValidEnvKey, parseEnv } from "../env/parser";
import { serializeCsv, serializeEnv, serializeJson, serializeShell } from "../env/serializer";
import { normaliseServerUrl } from "../server/client";
import { sendControlOperation } from "../server/control-client";
import type { ControlListRow, ControlOperation } from "../server/control";
import { isPlainHttpToRemote } from "../server/net";
import { maskSecret } from "../security/masking";
import { flagBool, flagList, flagString, requirePositional } from "../utils/args";
import { ExitCode, ProjectNotFoundError, SecretNotFoundError, UsageError } from "../utils/errors";
import { formatSuccess, formatWarning, padName } from "../utils/output";
import { writeFileAtomic } from "../utils/fs";
import type { AppContext, SecretScope } from "../core/types";
import type { ParsedArgs } from "../utils/args";
import { resolveShareToken } from "./share-token";
import { trimTrailingNewline } from "./shared";

const USAGE = "Usage: envvault remote <url> <list|get|set|delete|export|import|project> [...]";

interface ListResult {
  rows: ControlListRow[];
}

export function remoteScope(flags: ParsedArgs["flags"]): SecretScope {
  const project = flagString(flags, "project");
  if (flagBool(flags, "global")) {
    if (project !== undefined || flagBool(flags, "shared") || flagString(flags, "env") !== undefined) {
      throw new UsageError("--global cannot be combined with --project, --env or --shared.");
    }
    return { kind: "global" };
  }
  if (project === undefined) {
    throw new UsageError(
      "Choose a remote scope.",
      "Pass --global, or --project <name> with --env <environment> or --shared.",
    );
  }
  if (flagBool(flags, "shared")) return { kind: "project", project };
  const environment = flagString(flags, "env");
  if (environment === undefined) {
    throw new UsageError(
      `No environment selected for project: ${project}`,
      "Pass --env <environment> or --shared to target the project-wide secrets.",
    );
  }
  return { kind: "environment", project, environment };
}

export function remoteScopeLabel(scope: SecretScope): string {
  switch (scope.kind) {
    case "global":
      return "Global";
    case "project":
      return `${scope.project} / shared`;
    case "environment":
      return `${scope.project} / ${scope.environment}`;
  }
}

function originLabel(origin: ControlListRow["origin"]): string {
  return origin === "project" ? "project shared" : origin;
}

export async function remoteCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const url = requirePositional(args.positionals, 0, USAGE);
  const command = requirePositional(args.positionals, 1, USAGE);
  const baseUrl = normaliseServerUrl(url);

  if (isPlainHttpToRemote(baseUrl)) {
    ctx.io.stderr(
      formatWarning("plain HTTP sends the token unencrypted. Use HTTPS or a trusted encrypted tunnel."),
    );
  }

  const { token } = await resolveShareToken(ctx, args, baseUrl);
  const send = <T>(operation: ControlOperation): Promise<T> => sendControlOperation<T>(baseUrl, token, operation);

  switch (command) {
    case "list":
      return await listRemote(ctx, args, send);
    case "get":
      return await getRemote(ctx, args, send);
    case "set":
      return await setRemote(ctx, args, send);
    case "delete":
      return await deleteRemote(ctx, args, send);
    case "export":
      return await exportRemote(ctx, args, send);
    case "import":
      return await importRemote(ctx, args, send);
    case "project":
      return await projectRemote(ctx, args, send);
    default:
      throw new UsageError(`Unknown remote command: ${command}`, USAGE);
  }
}

type Send = <T>(operation: ControlOperation) => Promise<T>;

async function listRemote(ctx: AppContext, args: ParsedArgs, send: Send): Promise<number> {
  const scope = remoteScope(args.flags);
  const { rows } = await send<ListResult>({ op: "list", scope });
  const header = remoteScopeLabel(scope);
  const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name));

  if (flagBool(args.flags, "json")) {
    ctx.io.stdout(JSON.stringify({ scope: header, secrets: sorted.map(({ name, origin }) => ({ name, origin })) }));
    return ExitCode.Success;
  }

  ctx.io.stdout(header);
  ctx.io.stdout("");
  if (sorted.length === 0) {
    ctx.io.stdout("No secrets found.");
    return ExitCode.Success;
  }
  const showOrigins = flagBool(args.flags, "origins");
  for (const row of sorted) {
    ctx.io.stdout(`${padName(row.name)} ${showOrigins ? originLabel(row.origin) : maskSecret(row.value)}`);
  }
  return ExitCode.Success;
}

async function getRemote(ctx: AppContext, args: ParsedArgs, send: Send): Promise<number> {
  const name = requirePositional(args.positionals, 2, "Usage: envvault remote <url> get <NAME> --global|--project ... [--raw]");
  const scope = remoteScope(args.flags);
  const result = await send<{ found: boolean; value?: string }>({ op: "get", scope, name });
  if (!result.found || result.value === undefined) throw new SecretNotFoundError(name, remoteScopeLabel(scope));

  if (flagBool(args.flags, "raw")) {
    ctx.io.stdout(result.value);
    return ExitCode.Success;
  }
  if (flagBool(args.flags, "reveal")) {
    ctx.io.stderr(formatWarning("secret will be printed to stdout."));
    ctx.io.stdout(`${name}=${result.value}`);
    return ExitCode.Success;
  }
  ctx.io.stdout(`${name}=${maskSecret(result.value)}`);
  return ExitCode.Success;
}

async function setRemote(ctx: AppContext, args: ParsedArgs, send: Send): Promise<number> {
  const name = requirePositional(args.positionals, 2, "Usage: envvault remote <url> set <NAME> --stdin <scope>");
  if (!isValidEnvKey(name)) throw new UsageError(`Invalid secret name: ${name}`);
  if (!flagBool(args.flags, "stdin")) {
    throw new UsageError("Pass --stdin and provide the value on standard input.");
  }
  const scope = remoteScope(args.flags);
  const value = trimTrailingNewline(await ctx.io.readStdin());
  await send<{ ok: boolean }>({ op: "set", scope, name, value });
  ctx.io.stdout(formatSuccess(`Saved ${name} in ${remoteScopeLabel(scope)} on the server.`));
  return ExitCode.Success;
}

async function deleteRemote(ctx: AppContext, args: ParsedArgs, send: Send): Promise<number> {
  const name = requirePositional(args.positionals, 2, "Usage: envvault remote <url> delete <NAME> <scope> [--yes]");
  const scope = remoteScope(args.flags);
  const label = remoteScopeLabel(scope);
  if (!flagBool(args.flags, "yes")) {
    if (!ctx.io.isTTY) throw new UsageError("Refusing to delete a remote secret without confirmation.", "Pass --yes to confirm.");
    if (!(await ctx.io.confirm(`Delete ${name} from ${label} on the server?`))) {
      ctx.io.stdout("Aborted.");
      return ExitCode.Success;
    }
  }
  const result = await send<{ deleted: boolean }>({ op: "delete", scope, name });
  if (!result.deleted) throw new SecretNotFoundError(name, label);
  ctx.io.stdout(formatSuccess(`Deleted ${name} from ${label} on the server.`));
  return ExitCode.Success;
}

async function exportRemote(ctx: AppContext, args: ParsedArgs, send: Send): Promise<number> {
  const scope = remoteScope(args.flags);
  const format = flagString(args.flags, "format") ?? "env";
  const serializers: Record<string, (secrets: Record<string, string>) => string> = {
    env: serializeEnv,
    json: serializeJson,
    csv: serializeCsv,
    shell: serializeShell,
  };
  const serialize = serializers[format];
  if (serialize === undefined) throw new UsageError(`Unknown export format: ${format}`, "Use env, json, csv or shell.");

  const { secrets } = await send<{ secrets: Record<string, string> }>({ op: "export", scope });
  const content = serialize(secrets);
  const output = flagString(args.flags, "output");
  if (output === undefined) {
    if (Object.keys(secrets).length > 0) ctx.io.stdout(content.replace(/\n$/, ""));
    return ExitCode.Success;
  }

  const count = Object.keys(secrets).length;
  ctx.io.stderr(formatWarning("this creates a plaintext secret file."));
  await writeFileAtomic(resolve(ctx.cwd, output), content, 0o600);
  ctx.io.stdout(formatSuccess(`Wrote ${count} secret${count === 1 ? "" : "s"} to ${output}`));
  return ExitCode.Success;
}

async function importRemote(ctx: AppContext, args: ParsedArgs, send: Send): Promise<number> {
  const file = requirePositional(args.positionals, 2, "Usage: envvault remote <url> import <file> <scope> [--overwrite]");
  const scope = remoteScope(args.flags);
  const overwrite = flagBool(args.flags, "overwrite");
  const content = await readFile(resolve(ctx.cwd, file), "utf8");
  const entries = parseEnv(content).filter((entry) => isValidEnvKey(entry.key));

  const existing = new Set(
    (await send<ListResult>({ op: "list", scope })).rows.map((row) => row.name),
  );
  let written = 0;
  let skipped = 0;
  for (const entry of entries) {
    if (existing.has(entry.key) && !overwrite) {
      skipped += 1;
      continue;
    }
    await send<{ ok: boolean }>({ op: "set", scope, name: entry.key, value: entry.value });
    written += 1;
  }
  ctx.io.stdout(formatSuccess(`Imported ${written} secret${written === 1 ? "" : "s"} into ${remoteScopeLabel(scope)}.`));
  if (skipped > 0) ctx.io.stdout(`Skipped ${skipped} existing key${skipped === 1 ? "" : "s"}; pass --overwrite to replace them.`);
  return ExitCode.Success;
}

interface RemoteProjects {
  globalSecretCount: number;
  projects: {
    name: string;
    sharedSecretCount: number;
    environments: { name: string; secretCount: number }[];
  }[];
}

async function projectRemote(ctx: AppContext, args: ParsedArgs, send: Send): Promise<number> {
  const subcommand = args.positionals[2];
  switch (subcommand) {
    case undefined:
    case "list": {
      const state = await send<RemoteProjects>({ op: "projects" });
      if (flagBool(args.flags, "json")) {
        ctx.io.stdout(JSON.stringify(state));
        return ExitCode.Success;
      }
      ctx.io.stdout("Projects");
      ctx.io.stdout("");
      if (state.projects.length === 0) ctx.io.stdout("No projects yet.");
      for (const project of state.projects) {
        ctx.io.stdout(project.name);
        if (flagBool(args.flags, "environments")) {
          for (const environment of project.environments) ctx.io.stdout(`  ${environment.name}`);
        }
      }
      return ExitCode.Success;
    }
    case "add": {
      const name = requirePositional(args.positionals, 3, "Usage: envvault remote <url> project add <name> [--env <a,b>]");
      const environments = flagList(args.flags, "env");
      const added = await send<{ result: { created: boolean } }>({ op: "addProject", project: name });
      ctx.io.stdout(formatSuccess(added.result.created ? `Created project: ${name}` : `Project already exists: ${name}`));
      for (const environment of environments) {
        const result = await send<{ created: boolean }>({ op: "addEnvironment", project: name, environment });
        ctx.io.stdout(
          result.created
            ? formatSuccess(`Created environment: ${name}/${environment}`)
            : formatWarning(`Environment already exists: ${name}/${environment}`),
        );
      }
      return ExitCode.Success;
    }
    case "remove":
    case "rm": {
      const name = requirePositional(args.positionals, 3, "Usage: envvault remote <url> project remove <name> [--yes]");
      if (!flagBool(args.flags, "yes")) {
        if (!ctx.io.isTTY) throw new UsageError("Refusing to remove a remote project without confirmation.", "Pass --yes to confirm.");
        if (!(await ctx.io.confirm(`Remove project "${name}" and all of its secrets on the server? This cannot be undone.`))) {
          ctx.io.stdout("Aborted.");
          return ExitCode.Success;
        }
      }
      const result = await send<{ removed: boolean }>({ op: "removeProject", project: name });
      if (!result.removed) throw new ProjectNotFoundError(name);
      ctx.io.stdout(formatSuccess(`Removed project: ${name}`));
      return ExitCode.Success;
    }
    default:
      throw new UsageError(`Unknown project subcommand: ${subcommand}`, "Usage: envvault remote <url> project <list|add|remove>");
  }
}
