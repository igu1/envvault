/**
 * Directory -> project/environment resolution.
 *
 * Mappings live in `~/.envvault/contexts.json` and are matched by longest
 * directory prefix, so `/home/me/proj/backend` inherits a mapping for
 * `/home/me/proj` unless a more specific mapping exists.
 *
 * A project-local `.envvault.json` (with `project` + `environment`) is used as
 * a fallback when no directory mapping matches.
 */

import { resolve, sep } from "node:path";

import { findProjectConfig } from "./config";
import { readContextsFile, writeContextsFile } from "./storage";
import type { ContextMapping } from "./types";

export type ContextSource = "contexts" | "project-config";

export interface ResolvedContext extends ContextMapping {
  /** Directory that produced the match. */
  directory: string;
  source: ContextSource;
}

export interface ContextMatch {
  directory: string;
  mapping: ContextMapping;
}

/** Longest-prefix match; returns the most specific mapping. */
export function findContextMapping(
  contexts: Record<string, ContextMapping>,
  cwd: string,
): ContextMatch | null {
  const target = resolve(cwd);
  let best: ContextMatch | null = null;

  for (const [directory, mapping] of Object.entries(contexts)) {
    const absolute = resolve(directory);
    const matches = target === absolute || target.startsWith(absolute + sep);
    if (!matches) continue;
    if (best === null || absolute.length > resolve(best.directory).length) {
      best = { directory: absolute, mapping };
    }
  }

  return best;
}

export async function resolveDirectoryContext(
  home: string,
  cwd: string,
): Promise<ResolvedContext | null> {
  const contextsFile = await readContextsFile(home);
  const match = findContextMapping(contextsFile.contexts, cwd);
  if (match !== null) {
    return {
      project: match.mapping.project,
      environment: match.mapping.environment,
      directory: match.directory,
      source: "contexts",
    };
  }

  const projectConfig = await findProjectConfig(cwd);
  if (
    projectConfig !== null &&
    projectConfig.config.project !== undefined &&
    projectConfig.config.environment !== undefined
  ) {
    return {
      project: projectConfig.config.project,
      environment: projectConfig.config.environment,
      directory: projectConfig.dir,
      source: "project-config",
    };
  }

  return null;
}

/** Bind a directory to a context. Returns the normalized directory. */
export async function setDirectoryContext(
  home: string,
  directory: string,
  mapping: ContextMapping,
): Promise<string> {
  const contextsFile = await readContextsFile(home);
  const normalized = resolve(directory);
  contextsFile.contexts[normalized] = { project: mapping.project, environment: mapping.environment };
  await writeContextsFile(home, contextsFile);
  return normalized;
}

export async function listContexts(home: string): Promise<Record<string, ContextMapping>> {
  const contextsFile = await readContextsFile(home);
  return contextsFile.contexts;
}

/** Remove the exact mapping for one directory. Returns true when one existed. */
export async function removeDirectoryContext(home: string, directory: string): Promise<boolean> {
  const contextsFile = await readContextsFile(home);
  const normalized = resolve(directory);
  if (!Object.prototype.hasOwnProperty.call(contextsFile.contexts, normalized)) return false;
  delete contextsFile.contexts[normalized];
  await writeContextsFile(home, contextsFile);
  return true;
}

/** Remove every directory mapping that points at a project (or its envs). */
export async function removeContextsForProject(
  home: string,
  project: string,
  environment?: string,
): Promise<string[]> {
  const contextsFile = await readContextsFile(home);
  const removed: string[] = [];

  for (const [directory, mapping] of Object.entries(contextsFile.contexts)) {
    const projectMatches = mapping.project === project;
    const environmentMatches = environment === undefined || mapping.environment === environment;
    if (projectMatches && environmentMatches) {
      delete contextsFile.contexts[directory];
      removed.push(directory);
    }
  }

  if (removed.length > 0) await writeContextsFile(home, contextsFile);
  return removed.sort();
}
