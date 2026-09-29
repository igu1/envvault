import { clearSession } from "../core/session";
import type { AppContext } from "../core/types";
import { ExitCode } from "../utils/errors";
import { formatSuccess } from "../utils/output";

/** `envvault lock` — remove the cached unlock session. */
export async function lockCommand(ctx: AppContext): Promise<number> {
  const existed = await clearSession(ctx.home);
  if (existed) {
    ctx.io.stdout(formatSuccess("Vault locked"));
  } else {
    ctx.io.stdout("No active session.");
  }
  return ExitCode.Success;
}
