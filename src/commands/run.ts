import { resolveSecrets } from "../core/resolver";
import { resolveContextOrThrow } from "../core/scope";
import { openVault } from "../core/unlock";
import { assertEnvironment } from "../core/vault";
import type { AppContext } from "../core/types";
import { ExitCode, UsageError } from "../utils/errors";
import { optionBool, optionString, parseLeadingOptions } from "../utils/args";
import { style } from "../utils/output";
import { runProcess } from "../utils/process";

/**
 * `envvault run [--project <p>] [--env <e>] -- <command> [args...]`
 *
 * The command runs with the resolved secrets merged into its environment. The
 * child has no dependency on EnvVault.
 */
export async function runCommand(ctx: AppContext, argv: readonly string[]): Promise<number> {
  const { options, rest } = parseLeadingOptions(argv, {
    project: "value",
    env: "value",
    quiet: "boolean",
  });

  if (rest.length === 0) {
    throw new UsageError(
      "No command provided.",
      "Usage: envvault run [--project <project>] [--env <environment>] -- <command> [args...]",
    );
  }

  // `run` hands stdin to the child, so the password must never be read from
  // the pipe.
  const { vault } = await openVault(ctx, { allowStdinPassword: false });
  const context = await resolveContextOrThrow(ctx, {
    project: optionString(options, "project"),
    environment: optionString(options, "env"),
  });
  assertEnvironment(vault, context.project, context.environment);

  const secrets = resolveSecrets(vault, context);
  const env: NodeJS.ProcessEnv = { ...ctx.env, ...secrets };

  if (!optionBool(options, "quiet") && ctx.io.isTTY) {
    const count = Object.keys(secrets).length;
    ctx.io.stderr(
      style.dim(
        `envvault ▸ ${context.project}/${context.environment} (${count} secret${count === 1 ? "" : "s"})`,
      ),
    );
  }

  const [command, ...commandArgs] = rest as [string, ...string[]];
  const result = await runProcess(command, commandArgs, { cwd: ctx.cwd, env });
  return result.code;
}
