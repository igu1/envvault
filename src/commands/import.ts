import { resolve } from "node:path";

import { getScopedSecretEntry } from "../core/resolver";
import { resolveScope } from "../core/scope";
import { openVault } from "../core/unlock";
import { saveVaultWithKey, scopeLabel, setSecret } from "../core/vault";
import { parseEnv } from "../env/parser";
import type { AppContext } from "../core/types";
import { ConfigError, ExitCode } from "../utils/errors";
import { readTextFile } from "../utils/fs";
import { flagBool } from "../utils/args";
import type { ParsedArgs } from "../utils/args";
import { formatSuccess } from "../utils/output";
import { scopeFlagsFrom } from "./shared";

export async function importCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const file = args.positionals[0] ?? ".env";
  const absolute = resolve(ctx.cwd, file);
  const content = await readTextFile(absolute);
  if (content === null) throw new ConfigError(`File not found: ${file}`);

  const entries = parseEnv(content);
  const overwrite = flagBool(args.flags, "overwrite");

  const { vault, key } = await openVault(ctx);
  const scope = await resolveScope(ctx, vault, scopeFlagsFrom(args.flags));

  ctx.io.stdout(`Importing ${file}`);
  ctx.io.stdout("");

  if (entries.length === 0) {
    ctx.io.stdout("No variables found.");
    return ExitCode.Success;
  }

  let imported = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (!overwrite && getScopedSecretEntry(vault, scope, entry.key) !== undefined) {
      ctx.io.stdout(`${entry.key} already exists.`);
      skipped += 1;
      continue;
    }
    setSecret(vault, scope, entry.key, entry.value);
    imported += 1;
    ctx.io.stdout(formatSuccess(entry.key));
  }

  await saveVaultWithKey(ctx.home, vault, key);

  ctx.io.stdout("");
  ctx.io.stdout(
    `Imported ${imported} secret${imported === 1 ? "" : "s"} into ${scopeLabel(scope)}.`,
  );
  if (skipped > 0) ctx.io.stdout(`${skipped} already existed.`);
  ctx.io.stdout("");
  ctx.io.stdout("You can delete the original .env after verifying the import.");
  return ExitCode.Success;
}
