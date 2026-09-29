import { resolveSecrets } from "../core/resolver";
import { resolveContextOrThrow } from "../core/scope";
import { openVault } from "../core/unlock";
import { assertEnvironment } from "../core/vault";
import { runDockerBuild } from "../docker/build";
import { runDockerCompose } from "../docker/compose";
import { loadDockerSettings } from "../docker/config";
import type { DockerSettings } from "../docker/config";
import { buildDockerPlan, dockerPlanExitCode, formatDockerPlan } from "../docker/plan";
import { buildDockerRunArgs, runDocker } from "../docker/run";
import { selectSecrets } from "../docker/secrets";
import type { AppContext } from "../core/types";
import { ExitCode, UsageError } from "../utils/errors";
import {
  extractOptions,
  flagString,
  optionBool,
  optionList,
  optionString,
  parseArgs,
  parseLeadingOptions,
} from "../utils/args";
import { formatWarning, style } from "../utils/output";
import { pickSecrets } from "./shared";

const DOCKER_USAGE =
  "Usage: envvault docker <run|compose|build|plan> ...\n\n  envvault docker run <image>\n  envvault docker compose up\n  envvault docker build .\n  envvault docker plan\n\nEnvVault options such as --only, --service and --mode may appear anywhere.\nConsider writing \"--\" before the Docker arguments to pass them through untouched.";

/**
 * Parse EnvVault's own flags out of a pass-through argument list.
 *
 * `--quiet` is only recognized in the leading position so it can never be
 * confused with Docker's own `--quiet`. The remaining flags are safe to
 * extract from anywhere because they do not exist in the Docker CLI.
 */
function parseDockerArgs(
  argv: readonly string[],
  anywhere: Record<string, "boolean" | "value">,
): { options: Record<string, string | boolean>; rest: string[] } {
  const leading = parseLeadingOptions(argv, { quiet: "boolean" });
  const extracted = extractOptions(leading.rest, anywhere);
  const options: Record<string, string | boolean> = { ...extracted.options };
  if (leading.options.quiet === true) options.quiet = true;
  return { options, rest: extracted.rest };
}

export async function dockerCommand(ctx: AppContext, argv: readonly string[]): Promise<number> {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  switch (subcommand) {
    case "run":
      return await dockerRun(ctx, rest);
    case "compose":
      return await dockerCompose(ctx, rest);
    case "build":
      return await dockerBuild(ctx, rest);
    case "plan":
      return await dockerPlan(ctx, rest);
    case undefined:
      throw new UsageError("Missing docker subcommand.", DOCKER_USAGE);
    default:
      throw new UsageError(`Unknown docker subcommand: ${subcommand}`, DOCKER_USAGE);
  }
}

interface DockerInputs {
  context: { project: string; environment: string };
  resolved: Record<string, string>;
  settings: DockerSettings;
}

async function dockerInputs(ctx: AppContext): Promise<DockerInputs> {
  // Docker commands hand stdin to the child, so never read the password from it.
  const { vault } = await openVault(ctx, { allowStdinPassword: false });
  const context = await resolveContextOrThrow(ctx, {});
  assertEnvironment(vault, context.project, context.environment);
  const resolved = resolveSecrets(vault, context);
  const { settings } = await loadDockerSettings(ctx.cwd);
  return { context, resolved, settings };
}

function warnMissing(ctx: AppContext, missing: readonly string[]): void {
  if (missing.length === 0) return;
  ctx.io.stderr(
    formatWarning(
      `secret${missing.length === 1 ? "" : "s"} not found in vault: ${missing.join(", ")}`,
    ),
  );
}

function notify(
  ctx: AppContext,
  context: { project: string; environment: string },
  count: number,
  options: Record<string, string | boolean>,
): void {
  if (optionBool(options, "quiet") || !ctx.io.isTTY) return;
  ctx.io.stderr(
    style.dim(
      `envvault ▸ ${context.project}/${context.environment} (${count} secret${count === 1 ? "" : "s"})`,
    ),
  );
}

async function dockerPlan(ctx: AppContext, argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, ["json", "quiet"]);
  const { vault } = await openVault(ctx);
  const context = await resolveContextOrThrow(ctx, {
    project: flagString(args.flags, "project"),
    environment: flagString(args.flags, "env"),
  });
  assertEnvironment(vault, context.project, context.environment);

  const resolved = resolveSecrets(vault, context);
  const { settings } = await loadDockerSettings(ctx.cwd);
  const plan = buildDockerPlan(context.project, context.environment, settings, resolved);

  ctx.io.stdout(formatDockerPlan(plan));
  return dockerPlanExitCode(plan);
}

async function dockerRun(ctx: AppContext, argv: readonly string[]): Promise<number> {
  const { options, rest } = parseDockerArgs(argv, {
    service: "value",
    only: "value",
  });
  if (rest.length === 0) {
    throw new UsageError(
      "No docker arguments provided.",
      "Usage: envvault docker run [--service <name>] [--only A,B] <docker run args...>",
    );
  }

  const { context, resolved, settings } = await dockerInputs(ctx);
  const selection = selectSecrets(settings, Object.keys(resolved), {
    service: optionString(options, "service"),
    only: optionList(options, "only"),
  });
  warnMissing(ctx, selection.missing);
  notify(ctx, context, selection.names.length, options);

  const env: NodeJS.ProcessEnv = { ...ctx.env, ...pickSecrets(resolved, selection.names) };
  const dockerArgs = ["run", ...buildDockerRunArgs(rest, selection.names)];
  return await runDocker(dockerArgs, { cwd: ctx.cwd, env });
}

async function dockerCompose(ctx: AppContext, argv: readonly string[]): Promise<number> {
  const { options, rest } = parseDockerArgs(argv, {
    service: "value",
    only: "value",
    mode: "value",
  });
  if (rest.length === 0) {
    throw new UsageError(
      "No compose arguments provided.",
      "Usage: envvault docker compose [--mode env|secret] [--service <name>] [--only A,B] <compose args...>",
    );
  }

  const mode = optionString(options, "mode");
  if (mode !== undefined && mode !== "env" && mode !== "secret") {
    throw new UsageError(`Unknown docker mode: ${mode}`, 'Supported modes: "env", "secret".');
  }

  const { context, resolved, settings } = await dockerInputs(ctx);
  const effective: DockerSettings =
    mode === undefined ? settings : { ...settings, mode: mode === "secret" ? "secret" : "env" };

  const selection = selectSecrets(effective, Object.keys(resolved), {
    service: optionString(options, "service"),
    only: optionList(options, "only"),
  });
  warnMissing(ctx, selection.missing);
  notify(ctx, context, selection.names.length, options);

  // Compose performs ${VAR} interpolation from its own process environment, so
  // injection is exactly the same for `env` and `secret` modes; secret mode
  // simply relies on Compose's environment-backed secret definitions.
  const env: NodeJS.ProcessEnv = { ...ctx.env, ...pickSecrets(resolved, selection.names) };
  return await runDockerCompose(rest, { cwd: ctx.cwd, env });
}

async function dockerBuild(ctx: AppContext, argv: readonly string[]): Promise<number> {
  const { options, rest } = parseDockerArgs(argv, {
    only: "value",
  });
  if (rest.length === 0) {
    throw new UsageError(
      "No build arguments provided.",
      "Usage: envvault docker build [--only A,B] <docker build args...>",
    );
  }

  const { context, resolved, settings } = await dockerInputs(ctx);
  const available = new Set(Object.keys(resolved));
  const only = optionList(options, "only");
  const requested = only.length > 0 ? only : settings.buildSecrets;

  const buildSecrets = requested.filter((name) => available.has(name));
  const missing = requested.filter((name) => !available.has(name));

  warnMissing(ctx, missing);
  if (buildSecrets.length === 0) {
    ctx.io.stderr(
      formatWarning("no build secrets configured (docker.buildSecrets); building without secrets."),
    );
  }
  notify(ctx, context, buildSecrets.length, options);

  const env: NodeJS.ProcessEnv = { ...ctx.env, ...pickSecrets(resolved, buildSecrets) };
  return await runDockerBuild(rest, buildSecrets, { cwd: ctx.cwd, env });
}
