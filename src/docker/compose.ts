/**
 * `envvault docker compose`.
 *
 * EnvVault resolves the vault, injects the resulting variables into the Docker
 * Compose *process* environment, and then lets Compose perform `${VAR}`
 * interpolation exactly as it normally would. No `.env` file is required.
 */

import { runDocker } from "./run";
import type { DockerExecOptions } from "./run";

/** Compose arguments pass through unchanged; injection happens via env. */
export function buildDockerComposeArgs(composeArgs: readonly string[]): string[] {
  return [...composeArgs];
}

export async function runDockerCompose(
  composeArgs: readonly string[],
  options: DockerExecOptions,
): Promise<number> {
  return await runDocker(["compose", ...buildDockerComposeArgs(composeArgs)], options);
}
