import { resolveSecretDetails } from "../core/resolver";
import { resolveScopeOrGlobal } from "../core/scope";
import { openVault } from "../core/unlock";
import { maskSecret } from "../security/masking";
import type { AppContext, SecretOrigin } from "../core/types";
import { ExitCode } from "../utils/errors";
import { flagBool } from "../utils/args";
import type { ParsedArgs } from "../utils/args";
import { padName } from "../utils/output";
import { scopeFlagsFrom } from "./shared";

interface ListRow {
  name: string;
  value: string;
  origin: SecretOrigin;
}

function originLabel(origin: SecretOrigin): string {
  switch (origin) {
    case "environment":
      return "environment";
    case "project":
      return "project shared";
    case "global":
      return "global";
  }
}

/**
 * `envvault list`
 *
 * In a bound directory the resolved (environment > project > global) names are
 * listed. In an unbound directory the global secrets are listed instead of
 * failing, with a hint explaining that no project context is active.
 */
export async function listCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const showOrigins = flagBool(args.flags, "origins");
  const { vault } = await openVault(ctx);

  // No directory context falls back to globals, unless a scope was requested.
  const { scope, globalFallback: unbound } = await resolveScopeOrGlobal(
    ctx,
    vault,
    scopeFlagsFrom(args.flags),
  );

  let header: string;
  const rows: ListRow[] = [];

  switch (scope.kind) {
    case "global":
      header = unbound ? "Global (no project context)" : "Global";
      for (const [name, entry] of Object.entries(vault.globals)) {
        rows.push({ name, value: entry.value, origin: "global" });
      }
      break;
    case "project": {
      header = `${scope.project} / shared`;
      const shared = vault.projects[scope.project]?.shared ?? {};
      for (const [name, entry] of Object.entries(shared)) {
        rows.push({ name, value: entry.value, origin: "project" });
      }
      break;
    }
    case "environment": {
      header = `${scope.project} / ${scope.environment}`;
      for (const secret of resolveSecretDetails(vault, {
        project: scope.project,
        environment: scope.environment,
      })) {
        rows.push({ name: secret.name, value: secret.value, origin: secret.origin });
      }
      break;
    }
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));

  ctx.io.stdout(header);
  ctx.io.stdout("");

  if (rows.length === 0) {
    ctx.io.stdout("No secrets found.");
    if (!unbound) {
      ctx.io.stdout("");
      ctx.io.stdout("Add one with:");
      ctx.io.stdout("");
      ctx.io.stdout("  envvault set NAME");
    }
  } else {
    for (const row of rows) {
      const detail = showOrigins ? originLabel(row.origin) : maskSecret(row.value);
      ctx.io.stdout(`${padName(row.name)} ${detail}`);
    }
  }

  if (unbound) {
    ctx.io.stdout("");
    ctx.io.stdout("This directory is not bound to a project.");
    ctx.io.stdout("Bind it with: envvault use <project>/<environment>");
  }

  return ExitCode.Success;
}
