/** Small helpers shared by more than one command. */

import { flagBool, flagString } from "../utils/args";
import { resolveSecrets } from "../core/resolver";
import type { ScopeFlags } from "../core/scope";
import type { SecretEntry, SecretScope, VaultData } from "../core/types";

export function scopeFlagsFrom(flags: Record<string, string | boolean>): ScopeFlags {
  const result: ScopeFlags = {};
  if (flagBool(flags, "global")) result.global = true;
  const project = flagString(flags, "project");
  if (project !== undefined) result.project = project;
  const environment = flagString(flags, "env");
  if (environment !== undefined) result.environment = environment;
  if (flagBool(flags, "shared")) result.shared = true;
  return result;
}

function entriesToValues(entries: Record<string, SecretEntry>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, entry] of Object.entries(entries)) values[name] = entry.value;
  return values;
}

/**
 * Values visible in a scope. Environment scopes include globals and project
 * shared secrets (with the usual precedence); global/shared scopes are exact.
 */
export function secretsForScope(vault: VaultData, scope: SecretScope): Record<string, string> {
  switch (scope.kind) {
    case "global":
      return entriesToValues(vault.globals);
    case "project":
      return entriesToValues(vault.projects[scope.project]?.shared ?? {});
    case "environment":
      return resolveSecrets(vault, { project: scope.project, environment: scope.environment });
  }
}

export function pickSecrets(
  secrets: Record<string, string>,
  names: readonly string[],
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = secrets[name];
    if (value !== undefined) picked[name] = value;
  }
  return picked;
}

export function trimTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}
