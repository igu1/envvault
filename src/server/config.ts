/**
 * Read, validate and persist `~/.envvault/server.json`.
 *
 * The file is created lazily: a vault with no server configuration behaves as
 * "disabled", which is the safe default. Nothing here ever touches a secret
 * value — shares reference key *names* and tokens store a derived key.
 */

import { vaultPaths } from "../core/storage";
import { ConfigError } from "../utils/errors";
import { readJsonFile, writeJsonAtomic } from "../utils/fs";
import {
  CURRENT_SERVER_VERSION,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
} from "./types";
import type { ServerConfig, ServerToken, ShareDefinition, TokenGrant } from "./types";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TOKEN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function defaultServerConfig(): ServerConfig {
  return {
    version: CURRENT_SERVER_VERSION,
    enabled: false,
    host: DEFAULT_SERVER_HOST,
    port: DEFAULT_SERVER_PORT,
    shares: [],
    tokens: [],
  };
}

export function serverConfigPath(home: string): string {
  return vaultPaths(home).server;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateGrant(raw: unknown, source: string): TokenGrant {
  if (!isObject(raw)) throw new ConfigError(`${source}: "grant" must be an object.`);

  const sharesRaw = raw.shares;
  let shares: TokenGrant["shares"];
  if (sharesRaw === "all") {
    shares = "all";
  } else if (Array.isArray(sharesRaw) && sharesRaw.every((item) => typeof item === "string")) {
    shares = sharesRaw as string[];
  } else {
    throw new ConfigError(`${source}: "grant.shares" must be "all" or an array of share references.`);
  }

  if (raw.backup !== undefined && typeof raw.backup !== "boolean") {
    throw new ConfigError(`${source}: "grant.backup" must be a boolean.`);
  }

  return { shares, backup: raw.backup === true };
}

function validateShare(raw: unknown, source: string): ShareDefinition {
  if (!isObject(raw)) throw new ConfigError(`${source} must be an object.`);

  const { project, environment } = raw;
  if (typeof project !== "string" || !NAME_PATTERN.test(project)) {
    throw new ConfigError(`${source}: "project" is invalid.`);
  }
  if (typeof environment !== "string" || !NAME_PATTERN.test(environment)) {
    throw new ConfigError(`${source}: "environment" is invalid.`);
  }
  if (!Array.isArray(raw.keys) || !raw.keys.every((key) => typeof key === "string")) {
    throw new ConfigError(`${source}: "keys" must be an array of secret names.`);
  }

  const share: ShareDefinition = {
    project,
    environment,
    keys: [...new Set(raw.keys as string[])],
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
  };
  if (typeof raw.label === "string") share.label = raw.label;
  return share;
}

function validateToken(raw: unknown, source: string): ServerToken {
  if (!isObject(raw)) throw new ConfigError(`${source} must be an object.`);

  const { id, label, key, salt } = raw;
  if (typeof id !== "string" || !TOKEN_ID_PATTERN.test(id)) {
    throw new ConfigError(`${source}: "id" is invalid.`);
  }
  if (typeof label !== "string") throw new ConfigError(`${source}: "label" must be a string.`);
  if (typeof key !== "string" || key === "") throw new ConfigError(`${source}: "key" is missing.`);
  if (typeof salt !== "string" || salt === "") throw new ConfigError(`${source}: "salt" is missing.`);

  return {
    id,
    label,
    key,
    salt,
    grant: validateGrant(raw.grant, `${source}.grant`),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
  };
}

/** Validate an untrusted `server.json` document. */
export function validateServerConfig(raw: unknown, source = "server.json"): ServerConfig {
  if (!isObject(raw)) throw new ConfigError(`${source} must contain a JSON object.`);

  const version = typeof raw.version === "number" ? raw.version : CURRENT_SERVER_VERSION;
  if (version > CURRENT_SERVER_VERSION) {
    throw new ConfigError(
      `${source} was written by a newer EnvVault (version ${version}).`,
      "Upgrade EnvVault to manage this server configuration.",
    );
  }

  const host = typeof raw.host === "string" && raw.host !== "" ? raw.host : DEFAULT_SERVER_HOST;
  const port = typeof raw.port === "number" ? raw.port : DEFAULT_SERVER_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`${source}: "port" must be an integer between 0 and 65535.`);
  }

  const sharesRaw = raw.shares ?? [];
  if (!Array.isArray(sharesRaw)) throw new ConfigError(`${source}: "shares" must be an array.`);
  const tokensRaw = raw.tokens ?? [];
  if (!Array.isArray(tokensRaw)) throw new ConfigError(`${source}: "tokens" must be an array.`);

  const shares = sharesRaw.map((item, index) => validateShare(item, `${source}.shares[${index}]`));

  const seen = new Set<string>();
  for (const share of shares) {
    const key = `${share.project}/${share.environment}`;
    if (seen.has(key)) throw new ConfigError(`${source}: duplicate share for ${key}.`);
    seen.add(key);
  }

  const tokens = tokensRaw.map((item, index) => validateToken(item, `${source}.tokens[${index}]`));

  return { version, enabled: raw.enabled === true, host, port, shares, tokens };
}

/** Read the server configuration, falling back to a disabled default. */
export async function readServerConfig(home: string): Promise<ServerConfig> {
  const raw = await readJsonFile<unknown>(serverConfigPath(home));
  if (raw === null) return defaultServerConfig();
  return validateServerConfig(raw);
}

export async function writeServerConfig(home: string, config: ServerConfig): Promise<void> {
  await writeJsonAtomic(serverConfigPath(home), config, 0o600);
}
