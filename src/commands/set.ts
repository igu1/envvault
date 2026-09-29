import { openVault } from "../core/unlock";
import { resolveScopeOrGlobal } from "../core/scope";
import { isValidEnvKey } from "../env/parser";
import { scopeLabel, setSecret, saveVaultWithKey } from "../core/vault";
import type { AppContext } from "../core/types";
import { ExitCode, UsageError } from "../utils/errors";
import { flagBool, requirePositional } from "../utils/args";
import type { ParsedArgs } from "../utils/args";
import { formatSuccess, formatWarning, style } from "../utils/output";
import { scopeFlagsFrom, trimTrailingNewline } from "./shared";

export async function setCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const name = requirePositional(
    args.positionals,
    0,
    "Usage: envvault set <NAME> [--stdin] [--project <project>] [--env <environment>|--shared|--global]",
  );
  if (!isValidEnvKey(name)) {
    throw new UsageError(`Invalid secret name: ${name}`);
  }

  const fromStdin = flagBool(args.flags, "stdin");
  // `set` needs stdin for the value, so never read the password from it.
  const { vault, key } = await openVault(ctx, { allowStdinPassword: false });
  const { scope, globalFallback } = await resolveScopeOrGlobal(
    ctx,
    vault,
    scopeFlagsFrom(args.flags),
  );
  if (globalFallback) {
    ctx.io.stderr(style.dim("No project context; storing in global secrets."));
  }

  const value = fromStdin
    ? trimTrailingNewline(await ctx.io.readStdin())
    : await ctx.io.promptHidden(`${name}: `);

  if (!fromStdin && value === "") {
    ctx.io.stderr(formatWarning("No value entered; nothing was stored."));
    return ExitCode.Error;
  }

  const result = setSecret(vault, scope, name, value);
  await saveVaultWithKey(ctx.home, vault, key);

  const action = result.created ? "Stored" : "Updated";
  ctx.io.stdout(formatSuccess(`${action} ${name} in ${scopeLabel(scope)}`));
  return ExitCode.Success;
}
