/**
 * Least-privilege secret selection for Docker.
 *
 * A service only receives the secret names its `.envvault.json` allowlist
 * lists (plus, for `docker compose`, the union across services so that
 * `${VAR}` interpolation keeps working).
 */

import { ConfigError } from "../utils/errors";
import type { DockerSettings } from "./config";

export interface SecretSelection {
  /** Secret names that exist in the vault and will be injected. */
  names: string[];
  /** Names requested by configuration but missing from the vault. */
  missing: string[];
  /** True when no allowlist is configured (all resolved secrets are used). */
  unrestricted: boolean;
}

export function unionServiceSecrets(settings: DockerSettings): string[] {
  const union = new Set<string>();
  for (const names of Object.values(settings.services)) {
    for (const name of names) union.add(name);
  }
  return [...union].sort();
}

export interface SelectOptions {
  service?: string | undefined;
  only?: readonly string[] | undefined;
}

export function selectSecrets(
  settings: DockerSettings,
  availableNames: Iterable<string>,
  options: SelectOptions = {},
): SecretSelection {
  const available = new Set(availableNames);
  let requested: string[];
  let unrestricted = false;

  if (options.only !== undefined && options.only.length > 0) {
    requested = [...options.only];
  } else if (options.service !== undefined) {
    const configured = settings.services[options.service];
    if (configured === undefined) {
      const known = Object.keys(settings.services).sort();
      throw new ConfigError(
        `Service "${options.service}" has no docker.services allowlist in .envvault.json.`,
        known.length === 0
          ? "Add a docker.services entry for this service."
          : `Configured services: ${known.join(", ")}`,
      );
    }
    requested = configured;
  } else if (Object.keys(settings.services).length > 0) {
    requested = unionServiceSecrets(settings);
  } else {
    requested = [...available];
    unrestricted = true;
  }

  const names: string[] = [];
  const missing: string[] = [];
  for (const name of requested) {
    if (available.has(name)) {
      if (!names.includes(name)) names.push(name);
    } else if (!missing.includes(name)) {
      missing.push(name);
    }
  }

  return { names: names.sort(), missing: missing.sort(), unrestricted };
}
