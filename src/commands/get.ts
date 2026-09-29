import { getScopedSecretEntry, resolveSecret } from "../core/resolver";
import { resolveScopeOrGlobal } from "../core/scope";
import { openVault } from "../core/unlock";
import { scopeLabel } from "../core/vault";
import { maskSecret } from "../security/masking";
import type { AppContext } from "../core/types";
import { ExitCode, SecretNotFoundError } from "../utils/errors";
import { flagBool, requirePositional } from "../utils/args";
import type { ParsedArgs } from "../utils/args";
import { formatWarning, style } from "../utils/output";
import { scopeFlagsFrom } from "./shared";

export async function getCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const name = requirePositional(
    args.positionals,
    0,
    "Usage: envvault get <NAME> [--reveal] [--raw]",
  );
  const reveal = flagBool(args.flags, "reveal");
  const raw = flagBool(args.flags, "raw");

  const { vault } = await openVault(ctx);
  const { scope, globalFallback } = await resolveScopeOrGlobal(
    ctx,
    vault,
    scopeFlagsFrom(args.flags),
  );
  const label = scopeLabel(scope);
  if (globalFallback) {
    ctx.io.stderr(style.dim("No project context; reading from global secrets."));
  }

  const value =
    scope.kind === "environment"
      ? resolveSecret(vault, { project: scope.project, environment: scope.environment }, name)?.value
      : getScopedSecretEntry(vault, scope, name)?.value;

  if (value === undefined) throw new SecretNotFoundError(name, label);

  if (raw) {
    ctx.io.stdout(value);
    return ExitCode.Success;
  }

  if (reveal) {
    ctx.io.stderr(formatWarning("secret will be printed to stdout."));
    ctx.io.stdout(`${name}=${value}`);
    return ExitCode.Success;
  }

  ctx.io.stdout(`${name}=${maskSecret(value)}`);
  return ExitCode.Success;
}
