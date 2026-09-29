/**
 * `envvault docker run`.
 *
 * Secrets are passed to the Docker CLI process and referenced by name via
 * `--env NAME` (no `=value`). Docker then reads the value from its own
 * environment, so secret values never appear in argv or `ps` output.
 */

import { requireDocker, runProcess } from "../utils/process";

export interface DockerExecOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function buildDockerRunArgs(
  dockerArgs: readonly string[],
  secretNames: readonly string[],
): string[] {
  const injected: string[] = [];
  for (const name of secretNames) {
    injected.push("--env", name);
  }
  return [...injected, ...dockerArgs];
}

/** Spawn the Docker CLI with inherited stdio. Returns the exit code. */
export async function runDocker(
  args: readonly string[],
  options: DockerExecOptions,
): Promise<number> {
  await requireDocker();
  const result = await runProcess("docker", args, { cwd: options.cwd, env: options.env });
  return result.code;
}
