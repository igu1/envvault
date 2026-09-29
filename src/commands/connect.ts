/**
 * `envvault connect <url>` — pull shared environment keys into this vault.
 *
 * The remote payload is encrypted with a key derived from the share token, so
 * this command fetches ciphertext and decrypts it locally. Fetched keys are
 * written into a scope the caller chooses: global secrets, an existing project
 * shared space, or one of its environments.
 */

import { resolveDirectoryContext } from "../core/context";
import { openVault } from "../core/unlock";
import {
  assertEnvironment,
  assertProject,
  listEnvironments,
  listProjects,
  saveVaultWithKey,
  scopeLabel,
  setSecret,
} from "../core/vault";
import { maskSecret } from "../security/masking";
import { fetchHealth, fetchShareEnvelope, fetchShares, normaliseServerUrl } from "../server/client";
import { decryptShareEnvelope } from "../server/share";
import { assertTokenShape } from "../server/tokens";
import { shareRef, parseShareRef } from "../server/types";
import { askSelect } from "../ui/prompts";
import type { AppContext, SecretScope, VaultData } from "../core/types";
import type { SharePayload, ShareSummary } from "../server/types";
import type { ParsedArgs } from "../utils/args";
import { flagBool, flagString, requirePositional } from "../utils/args";
import { ExitCode, UsageError } from "../utils/errors";
import { formatSuccess, formatWarning, style } from "../utils/output";

export const SHARE_TOKEN_VAR = "ENVVAULT_SHARE_TOKEN";

/** Resolve a share token from the flag, the environment, or a hidden prompt. */
export async function resolveShareToken(ctx: AppContext, args: ParsedArgs): Promise<string> {
  const fromFlag = flagString(args.flags, "token");
  const fromEnv = ctx.env[SHARE_TOKEN_VAR];
  const token =
    fromFlag ??
    (fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined) ??
    (ctx.io.stdinIsTTY ? await ctx.io.promptHidden("Share token: ") : undefined);

  if (token === undefined || token.trim() === "") {
    throw new UsageError(
      "A share token is required.",
      `Pass --token <token> or set ${SHARE_TOKEN_VAR}.`,
    );
  }
  const trimmed = token.trim();
  assertTokenShape(trimmed);
  return trimmed;
}

export async function connectCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const url = requirePositional(
    args.positionals,
    0,
    "Usage: envvault connect <url> --token <token> [--share <project>/<env>] [--global|--project <p> --env <e>]",
  );
  const baseUrl = normaliseServerUrl(url);
  const token = await resolveShareToken(ctx, args);

  const health = await fetchHealth(baseUrl);
  const shares = await fetchShares(baseUrl, token);

  if (flagBool(args.flags, "list")) {
    return printShares(ctx, baseUrl, health.version, shares);
  }

  if (shares.length === 0) {
    ctx.io.stderr(formatWarning("The server has no shares available to this token."));
    return ExitCode.Error;
  }

  const chosen = await chooseShare(ctx, args, shares);
  if (chosen === null) {
    ctx.io.stdout("Cancelled.");
    return ExitCode.Success;
  }

  const envelope = await fetchShareEnvelope(baseUrl, token, chosen.project, chosen.environment);
  const payload = await decryptShareEnvelope(envelope, token);

  notifyPayload(ctx, baseUrl, payload);

  const dryRun = flagBool(args.flags, "dry-run");
  if (!dryRun && !flagBool(args.flags, "yes")) {
    const confirmed = await ctx.io.confirm(
      `Store ${Object.keys(payload.secrets).length} key(s) in this vault?`,
      true,
    );
    if (!confirmed) {
      ctx.io.stdout("Aborted.");
      return ExitCode.Success;
    }
  }

  if (dryRun) {
    ctx.io.stdout("");
    ctx.io.stdout("Dry run: nothing was written.");
    return ExitCode.Success;
  }

  const { vault, key } = await openVault(ctx);
  const scope = await chooseTargetScope(ctx, vault, args);

  let written = 0;
  for (const [name, value] of Object.entries(payload.secrets)) {
    setSecret(vault, scope, name, value);
    written += 1;
  }
  await saveVaultWithKey(ctx.home, vault, key);

  ctx.io.stdout("");
  ctx.io.stdout(formatSuccess(`Stored ${written} key(s) in ${scopeLabel(scope)}`));
  if (payload.missing.length > 0) {
    ctx.io.stderr(
      formatWarning(`missing on the server: ${payload.missing.join(", ")}`),
    );
  }
  return ExitCode.Success;
}

function printShares(
  ctx: AppContext,
  baseUrl: string,
  version: string,
  shares: ShareSummary[],
): number {
  const io = ctx.io;
  io.stdout(style.bold(`Shares on ${baseUrl}`));
  io.stdout(`EnvVault ${version}`);
  io.stdout("");
  if (shares.length === 0) {
    io.stdout("Nothing is shared with this token.");
    return ExitCode.Success;
  }
  for (const share of shares) {
    const label = share.label === undefined ? "" : `  (${share.label})`;
    io.stdout(`${shareRef(share.project, share.environment)}${label}  →  ${share.keys.join(", ")}`);
  }
  return ExitCode.Success;
}

async function chooseShare(
  ctx: AppContext,
  args: ParsedArgs,
  shares: ShareSummary[],
): Promise<ShareSummary | null> {
  const requested = flagString(args.flags, "share");
  if (requested !== undefined) {
    const ref = parseShareRef(requested);
    if (ref === null) {
      throw new UsageError(`Invalid --share value: ${requested}`, "Use project/environment.");
    }
    const match = shares.find(
      (share) => share.project === ref.project && share.environment === ref.environment,
    );
    if (match === undefined) {
      throw new UsageError(
        `That token has no share for ${shareRef(ref.project, ref.environment)}.`,
        "Run `envvault connect <url> --token <token> --list` to see the available shares.",
      );
    }
    return match;
  }

  if (shares.length === 1) return shares[0] ?? null;

  if (!ctx.io.stdinIsTTY) {
    throw new UsageError(
      "Several shares are available; choose one with --share <project>/<environment>.",
    );
  }

  const choice = await askSelect({
    message: "Share",
    options: shares.map((share) => ({
      value: shareRef(share.project, share.environment),
      label: `${shareRef(share.project, share.environment)}  (${share.keys.length} key(s))`,
    })),
  });
  if (choice === null) return null;
  return shares.find((share) => shareRef(share.project, share.environment) === choice) ?? null;
}

function notifyPayload(ctx: AppContext, baseUrl: string, payload: SharePayload): void {
  const io = ctx.io;
  const label = payload.label === undefined ? "" : ` (${payload.label})`;
  io.stdout(style.bold(`Share ${shareRef(payload.project, payload.environment)}${label}`));
  io.stdout(`From ${baseUrl}${payload.exportedAt === "" ? "" : ` · exported ${payload.exportedAt}`}`);
  io.stdout("");
  for (const [name, value] of Object.entries(payload.secrets)) {
    io.stdout(`${name}  ${maskSecret(value)}`);
  }
  if (Object.keys(payload.secrets).length === 0) {
    io.stdout("(no values in this share)");
  }
}

async function chooseTargetScope(
  ctx: AppContext,
  vault: VaultData,
  args: ParsedArgs,
): Promise<SecretScope> {
  const explicit =
    flagBool(args.flags, "global") ||
    flagBool(args.flags, "shared") ||
    flagString(args.flags, "project") !== undefined ||
    flagString(args.flags, "env") !== undefined;

  if (explicit) return resolveExplicitScope(ctx, vault, args);
  if (!ctx.io.stdinIsTTY) return { kind: "global" };

  const current = await resolveDirectoryContext(ctx.home, ctx.cwd);
  const options: Array<{ value: string; label: string }> = [
    { value: "global", label: "Global secrets" },
  ];
  if (current !== null) {
    options.push({
      value: `here`,
      label: `${current.project}/${current.environment} (current)`,
    });
  }
  options.push({ value: "other", label: "Another project…" });

  const choice = await askSelect({ message: "Store where?", options });
  if (choice === null) return { kind: "global" };
  if (choice === "global") return { kind: "global" };
  if (choice === "here" && current !== null) {
    return { kind: "environment", project: current.project, environment: current.environment };
  }

  const projects = listProjects(vault);
  if (projects.length === 0) {
    ctx.io.stdout("No projects yet; using global secrets.");
    return { kind: "global" };
  }
  const project = await askSelect({
    message: "Project",
    options: projects.map((name) => ({ value: name, label: name })),
  });
  if (project === null) return { kind: "global" };

  const envChoice = await askSelect({
    message: "Scope",
    options: [
      { value: "__shared__", label: `${project} (project shared)` },
      ...listEnvironments(vault, project).map((name) => ({
        value: `env:${name}`,
        label: `${project}/${name}`,
      })),
    ],
  });
  if (envChoice === null || envChoice === "__shared__") return { kind: "project", project };
  return { kind: "environment", project, environment: envChoice.slice("env:".length) };
}

function resolveExplicitScope(ctx: AppContext, vault: VaultData, args: ParsedArgs): SecretScope {
  if (flagBool(args.flags, "global")) {
    if (flagString(args.flags, "project") !== undefined || flagBool(args.flags, "shared")) {
      throw new UsageError("--global cannot be combined with --project, --env or --shared.");
    }
    return { kind: "global" };
  }

  const project = flagString(args.flags, "project");
  if (project === undefined || project === "") {
    throw new UsageError(
      "A target project is required.",
      "Pass --project <name> (with --env <environment> or --shared), or --global.",
    );
  }
  assertProject(vault, project);

  if (flagBool(args.flags, "shared")) return { kind: "project", project };

  const environment = flagString(args.flags, "env");
  if (environment === undefined || environment === "") {
    throw new UsageError(
      `No environment selected for ${project}.`,
      "Pass --env <environment>, --shared for project-wide secrets, or --global.",
    );
  }
  assertEnvironment(vault, project, environment);
  return { kind: "environment", project, environment };
}
