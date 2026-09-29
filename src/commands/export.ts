import { resolve } from "node:path";

import { resolveScope } from "../core/scope";
import { openVault } from "../core/unlock";
import { EXPORT_FORMATS, serializeSecrets } from "../env/serializer";
import type { ExportFormat } from "../env/serializer";
import type { AppContext } from "../core/types";
import { ExitCode, UsageError } from "../utils/errors";
import { flagString } from "../utils/args";
import type { ParsedArgs } from "../utils/args";
import { writeFileAtomic } from "../utils/fs";
import { formatSuccess, formatWarning } from "../utils/output";
import { secretsForScope, scopeFlagsFrom } from "./shared";

export async function exportCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const rawFormat = flagString(args.flags, "format") ?? "env";
  if (!EXPORT_FORMATS.includes(rawFormat as ExportFormat)) {
    throw new UsageError(
      `Unknown export format: ${rawFormat}`,
      `Supported formats: ${EXPORT_FORMATS.join(", ")}`,
    );
  }
  const format = rawFormat as ExportFormat;
  const output = flagString(args.flags, "output");

  const { vault } = await openVault(ctx);
  const scope = await resolveScope(ctx, vault, scopeFlagsFrom(args.flags));
  const secrets = secretsForScope(vault, scope);
  const count = Object.keys(secrets).length;
  const content = serializeSecrets(secrets, format);

  if (output === undefined) {
    if (count > 0) ctx.io.stdout(content.replace(/\n$/, ""));
    return ExitCode.Success;
  }

  const absolute = resolve(ctx.cwd, output);
  ctx.io.stderr(formatWarning("this creates a plaintext secret file."));
  await writeFileAtomic(absolute, content, 0o600);
  ctx.io.stdout(formatSuccess(`Wrote ${count} secret${count === 1 ? "" : "s"} to ${output}`));
  return ExitCode.Success;
}
