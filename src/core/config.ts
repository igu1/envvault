import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import { readJsonFile } from "../utils/fs";
import { ConfigError } from "../utils/errors";
import { createIo } from "../utils/prompt";
import { createClipboard } from "../security/clipboard";
import type {
  AppContext,
  DockerInjectionConfig,
  ProjectConfig,
} from "./types";

export const VERSION = "0.1.0";
export const PROJECT_CONFIG_FILENAME = ".envvault.json";

/**
 * Resolve the EnvVault home directory.
 *
 * `ENVVAULT_HOME` exists primarily so tests (and CI) never touch a real
 * `~/.envvault`.
 */
export function resolveVaultHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ENVVAULT_HOME;
  if (override !== undefined && override.trim() !== "") return resolve(override);
  return join(homedir(), ".envvault");
}

/** Render a path with `~` instead of the user's home directory. */
export function displayHome(path: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? homedir();
  if (path === home) return "~";
  if (path.startsWith(home + sep)) return `~${path.slice(home.length)}`;
  return path;
}

export function nowIso(): string {
  return new Date().toISOString();
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Validate and normalize an untrusted `.envvault.json` document. */
export function validateProjectConfig(raw: unknown, source: string): ProjectConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${source} must contain a JSON object.`);
  }
  const candidate = raw as Record<string, unknown>;
  const config: ProjectConfig = {};

  if (candidate.project !== undefined) {
    if (typeof candidate.project !== "string") {
      throw new ConfigError(`${source}: "project" must be a string.`);
    }
    config.project = candidate.project;
  }
  if (candidate.environment !== undefined) {
    if (typeof candidate.environment !== "string") {
      throw new ConfigError(`${source}: "environment" must be a string.`);
    }
    config.environment = candidate.environment;
  }

  if (candidate.docker !== undefined) {
    if (typeof candidate.docker !== "object" || candidate.docker === null) {
      throw new ConfigError(`${source}: "docker" must be an object.`);
    }
    const dockerRaw = candidate.docker as Record<string, unknown>;
    const docker: DockerInjectionConfig = {};

    if (dockerRaw.mode !== undefined) {
      if (dockerRaw.mode !== "env" && dockerRaw.mode !== "secret") {
        throw new ConfigError(`${source}: "docker.mode" must be "env" or "secret".`);
      }
      docker.mode = dockerRaw.mode;
    }

    if (dockerRaw.services !== undefined) {
      if (typeof dockerRaw.services !== "object" || dockerRaw.services === null) {
        throw new ConfigError(`${source}: "docker.services" must be an object.`);
      }
      const services: Record<string, string[]> = {};
      for (const [service, names] of Object.entries(dockerRaw.services as Record<string, unknown>)) {
        if (!isStringArray(names)) {
          throw new ConfigError(
            `${source}: "docker.services.${service}" must be an array of secret names.`,
          );
        }
        services[service] = names;
      }
      docker.services = services;
    }

    if (dockerRaw.buildSecrets !== undefined) {
      if (!isStringArray(dockerRaw.buildSecrets)) {
        throw new ConfigError(`${source}: "docker.buildSecrets" must be an array of secret names.`);
      }
      docker.buildSecrets = dockerRaw.buildSecrets;
    }

    config.docker = docker;
  }

  return config;
}

/** Read `.envvault.json` from a specific directory, if present. */
export async function readProjectConfig(dir: string): Promise<ProjectConfig | null> {
  const path = join(dir, PROJECT_CONFIG_FILENAME);
  const raw = await readJsonFile<unknown>(path);
  if (raw === null) return null;
  return validateProjectConfig(raw, PROJECT_CONFIG_FILENAME);
}

/** Walk up from `startDir` looking for the nearest `.envvault.json`. */
export async function findProjectConfig(
  startDir: string,
): Promise<{ path: string; dir: string; config: ProjectConfig } | null> {
  let dir = resolve(startDir);
  for (;;) {
    const config = await readProjectConfig(dir);
    if (config !== null) return { path: join(dir, PROJECT_CONFIG_FILENAME), dir, config };
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

export function createAppContext(overrides: Partial<AppContext> = {}): AppContext {
  const env = overrides.env ?? process.env;
  const home = overrides.home ?? resolveVaultHome(env);
  return {
    cwd: overrides.cwd ?? process.cwd(),
    home,
    env,
    io: overrides.io ?? createIo(),
    clipboard: overrides.clipboard ?? createClipboard({ env }),
  };
}
