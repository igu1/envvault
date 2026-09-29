import { removeContextsForProject } from "../core/context";
import { openVault } from "../core/unlock";
import {
  addEnvironment,
  addProject,
  assertProject,
  hasProject,
  listEnvironments,
  listProjects,
  removeProject,
  saveVaultWithKey,
} from "../core/vault";
import type { AppContext } from "../core/types";
import { ExitCode, UsageError } from "../utils/errors";
import { flagBool, flagList, requirePositional } from "../utils/args";
import type { ParsedArgs } from "../utils/args";
import { formatSuccess, formatWarning } from "../utils/output";

export async function projectCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const subcommand = args.positionals[0];
  switch (subcommand) {
    case "add":
      return await addCommand(ctx, args);
    case "list":
      return await listCommand(ctx, args);
    case "remove":
    case "rm":
      return await removeCommand(ctx, args);
    default:
      throw new UsageError(
        subcommand === undefined
          ? "Missing project subcommand."
          : `Unknown project subcommand: ${subcommand}`,
        "Usage: envvault project <add|list|remove>",
      );
  }
}

async function addCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const name = requirePositional(
    args.positionals,
    1,
    "Usage: envvault project add <name> [--env <environment>]",
  );
  const environments = flagList(args.flags, "env");

  const { vault, key } = await openVault(ctx);
  const projectExisted = hasProject(vault, name);

  if (!projectExisted) {
    addProject(vault, name);
    ctx.io.stdout(formatSuccess(`Created project: ${name}`));
  } else if (environments.length === 0) {
    ctx.io.stderr(formatWarning(`Project already exists: ${name}`));
    ctx.io.stderr(`Add an environment with: envvault project add ${name} --env <environment>`);
    return ExitCode.Error;
  }

  let created = 0;
  let existing = 0;
  for (const environment of environments) {
    if (addEnvironment(vault, name, environment)) {
      ctx.io.stdout(formatSuccess(`Created environment: ${name}/${environment}`));
      created += 1;
    } else {
      ctx.io.stderr(formatWarning(`Environment already exists: ${name}/${environment}`));
      existing += 1;
    }
  }

  await saveVaultWithKey(ctx.home, vault, key);
  return existing > 0 && created === 0 ? ExitCode.Error : ExitCode.Success;
}

async function listCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const { vault } = await openVault(ctx);
  const projects = listProjects(vault);
  const showEnvironments = flagBool(args.flags, "environments");

  ctx.io.stdout("Projects");
  ctx.io.stdout("");
  if (projects.length === 0) {
    ctx.io.stdout("No projects yet.");
    ctx.io.stdout("");
    ctx.io.stdout("Create one with:");
    ctx.io.stdout("");
    ctx.io.stdout("  envvault project add <name> --env dev");
    return ExitCode.Success;
  }
  for (const project of projects) {
    ctx.io.stdout(project);
    if (showEnvironments) {
      for (const environment of listEnvironments(vault, project)) {
        ctx.io.stdout(`  ${environment}`);
      }
    }
  }
  return ExitCode.Success;
}

async function removeCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const name = requirePositional(
    args.positionals,
    1,
    "Usage: envvault project remove <name> [--yes]",
  );
  const assumeYes = flagBool(args.flags, "yes");

  if (!assumeYes && !ctx.io.isTTY) {
    throw new UsageError(
      "Refusing to remove a project without confirmation in a non-interactive session.",
      "Pass --yes to confirm.",
    );
  }

  const { vault, key } = await openVault(ctx);
  assertProject(vault, name);

  if (!assumeYes) {
    const confirmed = await ctx.io.confirm(
      `Remove project "${name}" and all of its secrets? This cannot be undone.`,
    );
    if (!confirmed) {
      ctx.io.stdout("Aborted.");
      return ExitCode.Success;
    }
  }

  removeProject(vault, name);
  await saveVaultWithKey(ctx.home, vault, key);
  const cleared = await removeContextsForProject(ctx.home, name);

  ctx.io.stdout(formatSuccess(`Removed project: ${name}`));
  if (cleared.length > 0) {
    ctx.io.stdout(`Cleared ${cleared.length} directory mapping${cleared.length === 1 ? "" : "s"}.`);
  }
  return ExitCode.Success;
}
