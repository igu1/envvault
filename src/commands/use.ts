import { resolveDirectoryContext, setDirectoryContext } from "../core/context";
import { ContextNotFoundError, UsageError, ExitCode } from "../utils/errors";
import { openVault } from "../core/unlock";
import { assertEnvironment } from "../core/vault";
import type { AppContext } from "../core/types";
import type { ParsedArgs } from "../utils/args";
import { formatSuccess } from "../utils/output";

export async function useCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const target = args.positionals[0];
  if (target === undefined) return await showCurrent(ctx);

  let project: string | undefined;
  let environment: string | undefined;

  if (target.includes("/")) {
    const parts = target.split("/");
    project = parts[0];
    environment = parts[1];
  } else {
    project = target;
    const envFlag = args.flags.env;
    environment = typeof envFlag === "string" ? envFlag : undefined;
  }

  if (project === undefined || project === "" || environment === undefined || environment === "") {
    throw new UsageError(
      "Usage: envvault use <project>/<environment>",
      "For example:\n\n  envvault use crono/dev",
    );
  }

  const { vault } = await openVault(ctx);
  assertEnvironment(vault, project, environment);

  const directory = await setDirectoryContext(ctx.home, ctx.cwd, { project, environment });
  ctx.io.stdout(formatSuccess(`${project}/${environment} is now active in this directory`));
  ctx.io.stdout("");
  ctx.io.stdout(`  ${directory}`);
  return ExitCode.Success;
}

async function showCurrent(ctx: AppContext): Promise<number> {
  const current = await resolveDirectoryContext(ctx.home, ctx.cwd);
  if (current === null) throw new ContextNotFoundError(ctx.cwd);
  ctx.io.stdout(`${current.project}/${current.environment}`);
  ctx.io.stdout(`  ${current.directory} (${current.source})`);
  return ExitCode.Success;
}
