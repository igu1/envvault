/**
 * Translate CLI flags plus the active directory context into a `SecretScope`.
 *
 * This is the single place that decides whether `set`/`get`/`list`/`import`/
 * `export`/`delete` operate on globals, a project's shared secrets, or a
 * specific environment.
 */

import { resolveDirectoryContext } from "./context";
import { assertEnvironment, assertProject, listEnvironments } from "./vault";
import { ContextNotFoundError, UsageError } from "../utils/errors";
import type { AppContext, SecretScope, VaultData } from "./types";

export interface ScopeFlags {
  global?: boolean | undefined;
  project?: string | undefined;
  environment?: string | undefined;
  shared?: boolean | undefined;
}

function onlyEnvironment(vault: VaultData, project: string): string | undefined {
  const environments = listEnvironments(vault, project);
  return environments.length === 1 ? environments[0] : undefined;
}

export async function resolveScope(
  ctx: AppContext,
  vault: VaultData,
  flags: ScopeFlags,
): Promise<SecretScope> {
  if (flags.global === true) {
    if (flags.project !== undefined || flags.shared === true) {
      throw new UsageError("--global cannot be combined with --project, --env or --shared.");
    }
    return { kind: "global" };
  }

  const current = await resolveDirectoryContext(ctx.home, ctx.cwd);
  const project = flags.project ?? current?.project;

  if (project === undefined) {
    throw new ContextNotFoundError(ctx.cwd);
  }

  assertProject(vault, project);

  if (flags.shared === true) {
    return { kind: "project", project };
  }

  const environment =
    flags.environment ??
    (current !== null && current.project === project ? current.environment : undefined) ??
    onlyEnvironment(vault, project);

  if (environment === undefined) {
    throw new UsageError(
      `No environment selected for project: ${project}`,
      "Pass --env <environment> or --shared to target the project-wide secrets.",
    );
  }

  assertEnvironment(vault, project, environment);
  return { kind: "environment", project, environment };
}

/** Resolve the context a context-sensitive command should operate on. */
export async function resolveContextOrThrow(
  ctx: AppContext,
  flags: { project?: string | undefined; environment?: string | undefined },
): Promise<{ project: string; environment: string }> {
  const current = await resolveDirectoryContext(ctx.home, ctx.cwd);
  const project = flags.project ?? current?.project;
  const environment = flags.environment ?? current?.environment;
  if (project === undefined || environment === undefined) {
    throw new ContextNotFoundError(ctx.cwd);
  }
  return { project, environment };
}

export interface ResolvedScopeResult {
  scope: SecretScope;
  /** True when the directory had no context and globals were used instead. */
  globalFallback: boolean;
}

function hasExplicitScope(flags: ScopeFlags): boolean {
  return (
    flags.global === true ||
    flags.project !== undefined ||
    flags.environment !== undefined ||
    flags.shared === true
  );
}

/**
 * Like `resolveScope`, but for commands that can safely read or write globally
 * (`set`, `get`, `list`): when the directory has no context and the user did
 * not ask for an explicit scope, fall back to global secrets.
 */
export async function resolveScopeOrGlobal(
  ctx: AppContext,
  vault: VaultData,
  flags: ScopeFlags,
): Promise<ResolvedScopeResult> {
  try {
    return { scope: await resolveScope(ctx, vault, flags), globalFallback: false };
  } catch (error) {
    if (error instanceof ContextNotFoundError && !hasExplicitScope(flags)) {
      return { scope: { kind: "global" }, globalFallback: true };
    }
    throw error;
  }
}
