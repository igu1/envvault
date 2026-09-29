import { join, resolve } from "node:path";

import { PROJECT_CONFIG_FILENAME } from "../core/config";
import { removeDirectoryContext, resolveDirectoryContext } from "../core/context";
import type { AppContext } from "../core/types";
import { ExitCode } from "../utils/errors";
import type { ParsedArgs } from "../utils/args";
import { formatSuccess, formatWarning } from "../utils/output";

/**
 * `envvault unuse [directory]`
 *
 * Remove the directory -> project/environment mapping for the current
 * directory (or an explicit one). Does not need the master password because
 * `contexts.json` contains no secret values.
 */
export async function unuseCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const target = args.positionals[0];
  const directory = target === undefined ? ctx.cwd : resolve(ctx.cwd, target);

  if (await removeDirectoryContext(ctx.home, directory)) {
    ctx.io.stdout(formatSuccess(`Disconnected ${directory}`));
    return ExitCode.Success;
  }

  const current = await resolveDirectoryContext(ctx.home, directory);
  if (current === null) {
    ctx.io.stdout(`No directory mapping for ${directory}.`);
    return ExitCode.Success;
  }

  if (current.source === "project-config") {
    ctx.io.stderr(
      formatWarning(`${directory} is bound by ${join(current.directory, PROJECT_CONFIG_FILENAME)}.`),
    );
    ctx.io.stderr('Remove the "project" and "environment" fields from that file to disconnect.');
    return ExitCode.Error;
  }

  // The directory inherits a mapping from a parent; that parent is what owns
  // the entry, so tell the user how to remove it.
  ctx.io.stderr(formatWarning(`No mapping is stored for ${directory}.`));
  ctx.io.stderr(`It inherits ${current.project}/${current.environment} from ${current.directory}.`);
  ctx.io.stderr(`Run: envvault unuse ${current.directory}`);
  return ExitCode.Error;
}
