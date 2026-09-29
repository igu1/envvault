/**
 * Secret resolution.
 *
 * Precedence (lowest to highest):
 *   global < project shared < environment
 *
 * All functions are pure and never mutate the vault.
 */

import type {
  ResolvedSecret,
  ResolvedSecrets,
  SecretEntry,
  SecretScope,
  VaultContext,
  VaultData,
} from "./types";

function projectOf(vault: VaultData, project: string) {
  return vault.projects[project];
}

/** Resolve every secret visible in a project/environment, values only. */
export function resolveSecrets(vault: VaultData, context: VaultContext): ResolvedSecrets {
  const result: ResolvedSecrets = {};
  for (const secret of resolveSecretDetails(vault, context)) {
    result[secret.name] = secret.value;
  }
  return result;
}

/** Resolve every secret with its origin, for `list --origins` and doctor. */
export function resolveSecretDetails(vault: VaultData, context: VaultContext): ResolvedSecret[] {
  const merged = new Map<string, ResolvedSecret>();

  for (const [name, entry] of Object.entries(vault.globals)) {
    merged.set(name, { name, value: entry.value, origin: "global" });
  }

  const project = projectOf(vault, context.project);
  if (project !== undefined) {
    for (const [name, entry] of Object.entries(project.shared)) {
      merged.set(name, { name, value: entry.value, origin: "project" });
    }
    const environment = project.environments[context.environment];
    if (environment !== undefined) {
      for (const [name, entry] of Object.entries(environment.secrets)) {
        merged.set(name, { name, value: entry.value, origin: "environment" });
      }
    }
  }

  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveSecret(
  vault: VaultData,
  context: VaultContext,
  name: string,
): ResolvedSecret | undefined {
  const project = projectOf(vault, context.project);
  const environment = project?.environments[context.environment];

  const environmentEntry = environment?.secrets[name];
  if (environmentEntry !== undefined) {
    return { name, value: environmentEntry.value, origin: "environment" };
  }

  const sharedEntry = project?.shared[name];
  if (sharedEntry !== undefined) {
    return { name, value: sharedEntry.value, origin: "project" };
  }

  const globalEntry = vault.globals[name];
  if (globalEntry !== undefined) {
    return { name, value: globalEntry.value, origin: "global" };
  }

  return undefined;
}

export function resolveSecretNames(vault: VaultData, context: VaultContext): string[] {
  return resolveSecretDetails(vault, context).map((secret) => secret.name);
}

/** Read a single secret scoped exactly, without precedence fallbacks. */
export function getScopedSecretEntry(
  vault: VaultData,
  scope: SecretScope,
  name: string,
): SecretEntry | undefined {
  switch (scope.kind) {
    case "global":
      return vault.globals[name];
    case "project":
      return vault.projects[scope.project]?.shared[name];
    case "environment":
      return vault.projects[scope.project]?.environments[scope.environment]?.secrets[name];
  }
}

export function listScopeSecretNames(vault: VaultData, scope: SecretScope): string[] {
  switch (scope.kind) {
    case "global":
      return Object.keys(vault.globals).sort();
    case "project":
      return Object.keys(vault.projects[scope.project]?.shared ?? {}).sort();
    case "environment":
      return Object.keys(
        vault.projects[scope.project]?.environments[scope.environment]?.secrets ?? {},
      ).sort();
  }
}
