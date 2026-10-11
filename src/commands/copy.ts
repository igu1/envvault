import { getScopedSecretEntry, resolveSecret } from "../core/resolver";
import { resolveScopeOrGlobal } from "../core/scope";
import { openVault } from "../core/unlock";
import type { AppContext } from "../core/types";
import { ExitCode, SecretNotFoundError } from "../utils/errors";
import { flagNumber, requirePositional } from "../utils/args";
import type { ParsedArgs } from "../utils/args";
import { formatSuccess } from "../utils/output";
import { sleep } from "../utils/process";
import { scopeFlagsFrom } from "./shared";
import { scopeLabel } from "../core/vault";

const DEFAULT_CLEAR_SECONDS = 30;

export async function copyCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const name = requirePositional(
    args.positionals,
    0,
    "Usage: envvault copy <NAME> [--clear-after <seconds>] [--no-clear] [--global|--project <project> --env <environment>|--project <project> --shared]",
  );

  const { vault } = await openVault(ctx);
  const { scope } = await resolveScopeOrGlobal(ctx, vault, scopeFlagsFrom(args.flags));
  const secret = scope.kind === "environment"
    ? resolveSecret(vault, { project: scope.project, environment: scope.environment }, name)
    : getScopedSecretEntry(vault, scope, name);
  if (secret === undefined) {
    throw new SecretNotFoundError(name, scopeLabel(scope));
  }

  await ctx.clipboard.copy(secret.value);
  ctx.io.stdout(formatSuccess(`Copied ${name}`));

  const noClear = args.flags.clear === false;
  const seconds = flagNumber(args.flags, "clear-after") ?? DEFAULT_CLEAR_SECONDS;

  if (!noClear && seconds > 0) {
    ctx.io.stdout(`Clipboard will be cleared in ${seconds} seconds.`);
    await sleep(seconds * 1000);
    await ctx.clipboard.clear();
  }

  return ExitCode.Success;
}
