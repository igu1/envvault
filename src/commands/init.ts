import { displayHome, nowIso } from "../core/config";
import { ensureVaultDir, vaultExists, writeConfigFile, writeContextsFile, writeMetadataFile } from "../core/storage";
import { CURRENT_VAULT_VERSION } from "../core/types";
import { acquireNewPassword } from "../core/unlock";
import { createEmptyVault, saveVault } from "../core/vault";
import type { AppContext } from "../core/types";
import type { ParsedArgs } from "../utils/args";
import { ExitCode } from "../utils/errors";
import { formatSuccess } from "../utils/output";

export async function initCommand(ctx: AppContext, _args: ParsedArgs): Promise<number> {
  const io = ctx.io;
  io.stdout("EnvVault");
  io.stdout("");

  if (await vaultExists(ctx.home)) {
    io.stdout("EnvVault is already initialized.");
    io.stdout("");
    io.stdout(displayHome(ctx.home, ctx.env));
    return ExitCode.Success;
  }

  // Prompt before touching the filesystem so a cancelled prompt changes nothing.
  const password = await acquireNewPassword(ctx);

  await ensureVaultDir(ctx.home);
  const createdAt = nowIso();
  await writeConfigFile(ctx.home, { version: CURRENT_VAULT_VERSION, createdAt });
  await writeContextsFile(ctx.home, { version: CURRENT_VAULT_VERSION, contexts: {} });
  await writeMetadataFile(ctx.home, { version: CURRENT_VAULT_VERSION, createdAt });
  await saveVault(ctx.home, createEmptyVault(), password);

  io.stdout(formatSuccess(`Created ${displayHome(ctx.home, ctx.env)}`));
  io.stdout(formatSuccess("Created encrypted vault"));
  io.stdout("");
  io.stdout("EnvVault is ready.");
  return ExitCode.Success;
}
