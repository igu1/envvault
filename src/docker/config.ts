import { findProjectConfig } from "../core/config";
import type { DockerInjectionConfig, ProjectConfig } from "../core/types";

export interface DockerSettings {
  mode: "env" | "secret";
  /** Allowlist of secret names per Docker service. */
  services: Record<string, string[]>;
  buildSecrets: string[];
}

export function getDockerSettings(config: ProjectConfig | null): DockerSettings {
  const docker: DockerInjectionConfig | undefined = config?.docker;
  return {
    mode: docker?.mode ?? "env",
    services: docker?.services ?? {},
    buildSecrets: docker?.buildSecrets ?? [],
  };
}

export interface LoadedDockerSettings {
  settings: DockerSettings;
  config: ProjectConfig | null;
  /** Directory containing `.envvault.json`, when one was found. */
  configDir: string | null;
}

/** Find the nearest `.envvault.json` and normalise its docker section. */
export async function loadDockerSettings(cwd: string): Promise<LoadedDockerSettings> {
  const found = await findProjectConfig(cwd);
  return {
    settings: getDockerSettings(found?.config ?? null),
    config: found?.config ?? null,
    configDir: found?.dir ?? null,
  };
}
