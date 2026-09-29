import { DEFAULT_SESSION_TTL_MS, writeSession } from "../core/session";
import { unlockWithPrompt } from "../core/unlock";
import type { AppContext } from "../core/types";
import { ExitCode, UsageError } from "../utils/errors";
import { flagString } from "../utils/args";
import type { ParsedArgs } from "../utils/args";
import { formatDuration, parseDuration } from "../utils/duration";
import { formatSuccess } from "../utils/output";

/**
 * `envvault unlock [--ttl <duration>]`
 *
 * Verifies the master password and caches the derived key so subsequent
 * commands (most importantly `envvault run`) do not prompt.
 */
export async function unlockCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const ttlText = flagString(args.flags, "ttl");
  const ttlMs = ttlText === undefined ? DEFAULT_SESSION_TTL_MS : parseDuration(ttlText);
  if (ttlMs === null || ttlMs <= 0) {
    throw new UsageError(
      `Invalid --ttl value: ${ttlText ?? ""}`,
      "Use a duration such as 30m, 8h or 7d.",
    );
  }

  const { key, source } = await unlockWithPrompt(ctx);
  const expiresAt = await writeSession(ctx.home, key.key, ttlMs);

  ctx.io.stdout(formatSuccess("Vault unlocked"));
  if (source === "environment") {
    ctx.io.stdout("Using ENVVAULT_MASTER_PASSWORD; sessions are mainly for interactive use.");
  }
  ctx.io.stdout(
    `Session expires in ${formatDuration(ttlMs)} (${new Date(expiresAt).toLocaleString()}).`,
  );
  ctx.io.stdout("Run `envvault lock` to clear it now.");
  return ExitCode.Success;
}
