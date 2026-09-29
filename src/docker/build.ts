/**
 * `envvault docker build`.
 *
 * Secrets are exposed with BuildKit secret mounts, never build args:
 *
 *   --secret id=npm_token,env=NPM_TOKEN
 *
 * The Dockerfile consumes them via `RUN --mount=type=secret,id=npm_token ...`.
 */

import { runDocker } from "./run";
import type { DockerExecOptions } from "./run";

export function buildDockerBuildArgs(
  dockerArgs: readonly string[],
  secretNames: readonly string[],
): string[] {
  const injected: string[] = [];
  for (const name of secretNames) {
    injected.push("--secret", `id=${name.toLowerCase()},env=${name}`);
  }
  return [...injected, ...dockerArgs];
}

export async function runDockerBuild(
  buildArgs: readonly string[],
  secretNames: readonly string[],
  options: DockerExecOptions,
): Promise<number> {
  const env: NodeJS.ProcessEnv = { ...options.env, DOCKER_BUILDKIT: "1" };
  return await runDocker(
    ["build", ...buildDockerBuildArgs(buildArgs, secretNames)],
    { cwd: options.cwd, env },
  );
}
