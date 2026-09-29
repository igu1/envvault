import { getScopedSecretEntry } from "../core/resolver";
import { resolveScope } from "../core/scope";
import { openVault } from "../core/unlock";
import { deleteSecret, saveVaultWithKey, scopeLabel } from "../core/vault";
import type { AppContext } from "../core/types";
import { ExitCode, SecretNotFoundError, UsageError } from "../utils/errors";
import { flagBool, requirePositional } from "../utils/args";
import type { ParsedArgs } from "../utils/args";
import { formatSuccess } from "../utils/output";
import { scopeFlagsFrom } from "./shared";

export async function deleteCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const name = requirePositional(
    args.positionals,
    0,
    "Usage: envvault delete <NAME> [--yes]",
  );
  const assumeYes = flagBool(args.flags, "yes");

  // Fail fast before prompting for the master password.
  if (!assumeYes && !ctx.io.isTTY) {
    throw new UsageError(
      "Refusing to delete a secret without confirmation in a non-interactive session.",
      "Pass --yes to confirm.",
    );
  }

  const { vault, key } = await openVault(ctx);
  const scope = await resolveScope(ctx, vault, scopeFlagsFrom(args.flags));
  const label = scopeLabel(scope);

  if (getScopedSecretEntry(vault, scope, name) === undefined) {
    throw new SecretNotFoundError(name, label);
  }

  if (!assumeYes) {
    const confirmed = await ctx.io.confirm(`Delete ${name} from ${label}?`);
    if (!confirmed) {
      ctx.io.stdout("Aborted.");
      return ExitCode.Success;
    }
  }

  deleteSecret(vault, scope, name);
  await saveVaultWithKey(ctx.home, vault, key);
  ctx.io.stdout(formatSuccess(`Deleted ${name} from ${label}`));
  return ExitCode.Success;
}
