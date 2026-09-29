import { resolveSecret } from "../core/resolver";
import { resolveContextOrThrow } from "../core/scope";
import { openVault } from "../core/unlock";
import type { AppContext } from "../core/types";
import { ExitCode, SecretNotFoundError } from "../utils/errors";
import { flagNumber, requirePositional } from "../utils/args";
import type { ParsedArgs } from "../utils/args";
import { formatSuccess } from "../utils/output";
import { sleep } from "../utils/process";

const DEFAULT_CLEAR_SECONDS = 30;

export async function copyCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const name = requirePositional(
    args.positionals,
    0,
    "Usage: envvault copy <NAME> [--clear-after <seconds>] [--no-clear]",
  );

  const { vault } = await openVault(ctx);
  const context = await resolveContextOrThrow(ctx, {});
  const secret = resolveSecret(vault, context, name);
  if (secret === undefined) {
    throw new SecretNotFoundError(name, `${context.project}/${context.environment}`);
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
