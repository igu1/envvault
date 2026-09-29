/**
 * High-level server settings operations.
 *
 * Both the CLI (`envvault server`, `envvault share`) and the interactive UI go
 * through this module so the two surfaces cannot drift. Every function reads
 * and writes `server.json` atomically and validates its input before persisting.
 */

import { nowIso } from "../core/config";
import { resolveSecretNames } from "../core/resolver";
import { ServerConfigError, ShareNotFoundError } from "../utils/errors";
import { readServerConfig, writeServerConfig } from "./config";
import { createToken as makeToken } from "./tokens";
import { parseShareRef, shareRef } from "./types";
import type { VaultData } from "../core/types";
import type { ServerConfig, ServerToken, ShareDefinition, TokenGrant } from "./types";

export interface UpsertShareInput {
  project: string;
  environment: string;
  keys: string[];
  label?: string;
}

export interface UpsertShareResult {
  share: ShareDefinition;
  created: boolean;
}

/** Names in `keys` that are not visible in the given project/environment. */
export function missingShareKeys(
  vault: VaultData,
  project: string,
  environment: string,
  keys: readonly string[],
): string[] {
  const available = new Set(resolveSecretNames(vault, { project, environment }));
  return keys.filter((key) => !available.has(key));
}

export async function loadServerConfig(home: string): Promise<ServerConfig> {
  return await readServerConfig(home);
}

export async function setServerEnabled(home: string, enabled: boolean): Promise<ServerConfig> {
  const config = await readServerConfig(home);
  config.enabled = enabled;
  await writeServerConfig(home, config);
  return config;
}

export async function setServerBinding(
  home: string,
  binding: { host?: string | undefined; port?: number | undefined },
): Promise<ServerConfig> {
  const config = await readServerConfig(home);
  if (binding.host !== undefined) {
    if (binding.host.trim() === "") {
      throw new ServerConfigError("Host cannot be empty.");
    }
    config.host = binding.host.trim();
  }
  if (binding.port !== undefined) {
    if (!Number.isInteger(binding.port) || binding.port < 0 || binding.port > 65535) {
      throw new ServerConfigError(`Invalid port: ${binding.port}`);
    }
    config.port = binding.port;
  }
  await writeServerConfig(home, config);
  return config;
}

export function findShare(
  config: ServerConfig,
  project: string,
  environment: string,
): ShareDefinition | undefined {
  return config.shares.find(
    (share) => share.project === project && share.environment === environment,
  );
}

export function findShareByRef(config: ServerConfig, reference: string): ShareDefinition | undefined {
  const ref = parseShareRef(reference);
  if (ref === null) return undefined;
  return findShare(config, ref.project, ref.environment);
}

export async function listShares(home: string): Promise<ShareDefinition[]> {
  const config = await readServerConfig(home);
  return [...config.shares].sort((a, b) =>
    shareRef(a.project, a.environment).localeCompare(shareRef(b.project, b.environment)),
  );
}

export async function upsertShare(home: string, input: UpsertShareInput): Promise<UpsertShareResult> {
  const keys = [...new Set(input.keys.map((key) => key.trim()).filter((key) => key !== ""))];
  if (keys.length === 0) {
    throw new ServerConfigError(
      "A share needs at least one key.",
      "List keys with `envvault list`, then pass them with --keys NAME[,NAME...].",
    );
  }

  const config = await readServerConfig(home);
  const existing = findShare(config, input.project, input.environment);
  const now = nowIso();

  if (existing === undefined) {
    const share: ShareDefinition = {
      project: input.project,
      environment: input.environment,
      keys,
      createdAt: now,
      updatedAt: now,
    };
    if (input.label !== undefined && input.label !== "") share.label = input.label;
    config.shares.push(share);
    await writeServerConfig(home, config);
    return { share, created: true };
  }

  existing.keys = keys;
  existing.updatedAt = now;
  if (input.label !== undefined && input.label !== "") existing.label = input.label;
  await writeServerConfig(home, config);
  return { share: existing, created: false };
}

export async function removeShare(
  home: string,
  project: string,
  environment: string,
): Promise<boolean> {
  const config = await readServerConfig(home);
  const before = config.shares.length;
  config.shares = config.shares.filter(
    (share) => !(share.project === project && share.environment === environment),
  );
  if (config.shares.length === before) return false;
  await writeServerConfig(home, config);
  return true;
}

export function assertShareExists(
  config: ServerConfig,
  project: string,
  environment: string,
): ShareDefinition {
  const share = findShare(config, project, environment);
  if (share === undefined) throw new ShareNotFoundError(shareRef(project, environment));
  return share;
}

export async function listTokens(home: string): Promise<ServerToken[]> {
  const config = await readServerConfig(home);
  return [...config.tokens].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function normaliseGrant(grant: TokenGrant): TokenGrant {
  if (grant.shares === "all") return { shares: "all", backup: grant.backup };
  const refs = [...new Set(grant.shares)];
  for (const ref of refs) {
    if (parseShareRef(ref) === null) {
      throw new ServerConfigError(
        `Invalid share reference in grant: ${ref}`,
        "Use the form project/environment.",
      );
    }
  }
  return { shares: refs, backup: grant.backup };
}

export interface CreateTokenResult {
  token: string;
  record: ServerToken;
}

export async function createShareToken(
  home: string,
  label: string,
  grant: TokenGrant,
): Promise<CreateTokenResult> {
  const config = await readServerConfig(home);
  const { token, record } = await makeToken(label, normaliseGrant(grant), nowIso());
  config.tokens.push(record);
  await writeServerConfig(home, config);
  return { token, record };
}

export async function revokeShareToken(home: string, id: string): Promise<boolean> {
  const config = await readServerConfig(home);
  const before = config.tokens.length;
  config.tokens = config.tokens.filter((token) => token.id !== id);
  if (config.tokens.length === before) return false;
  await writeServerConfig(home, config);
  return true;
}

/** A one-line human summary of a grant. */
export function describeGrant(grant: TokenGrant): string {
  const shares =
    grant.shares === "all" ? "all shares" : `${grant.shares.length} share(s)`;
  const backup = grant.backup ? ", backups" : "";
  return `${shares}${backup}`;
}
