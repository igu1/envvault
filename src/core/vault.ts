/**
 * Vault persistence and pure data operations.
 *
 * Everything in this module operates on an in-memory `VaultData`. File I/O is
 * limited to `loadVault`/`saveVault`, which use the crypto envelope and atomic
 * writes. All mutation helpers are pure functions over `VaultData` so they are
 * easy to test.
 */

import { randomBytes } from "node:crypto";

import { ConfigError, EnvironmentNotFoundError, ProjectNotFoundError } from "../utils/errors";
import { wipe } from "../security/memory";
import { nowIso } from "./config";
import { SALT_BYTES, decryptVault, decryptWithKey, deriveKey, encryptWithKey } from "./crypto";
import { readEnvelopeFile, writeEnvelopeFile } from "./storage";
import { CURRENT_VAULT_VERSION } from "./types";
import type { SecretEntry, SecretScope, VaultData, VaultKey } from "./types";

const PROJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function createEmptyVault(): VaultData {
  return { version: CURRENT_VAULT_VERSION, globals: {}, projects: {} };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normaliseSecretEntry(value: unknown, context: string): SecretEntry {
  if (!isObject(value) || typeof value.value !== "string") {
    throw new ConfigError(`Vault data is corrupt: ${context} is not a valid secret entry.`);
  }
  const now = nowIso();
  return {
    value: value.value,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
    ...(typeof value.secret === "boolean" ? { secret: value.secret } : {}),
  };
}

function normaliseSecretMap(value: unknown, context: string): Record<string, SecretEntry> {
  if (value === undefined) return {};
  if (!isObject(value)) {
    throw new ConfigError(`Vault data is corrupt: ${context} is not an object.`);
  }
  const result: Record<string, SecretEntry> = {};
  for (const [name, entry] of Object.entries(value)) {
    result[name] = normaliseSecretEntry(entry, `${context}.${name}`);
  }
  return result;
}

/** Validate untrusted decrypted JSON into `VaultData`. */
export function validateVaultData(raw: unknown): VaultData {
  if (!isObject(raw)) {
    throw new ConfigError("Vault contents are not a valid object.");
  }

  const version = typeof raw.version === "number" ? raw.version : CURRENT_VAULT_VERSION;
  if (version > CURRENT_VAULT_VERSION) {
    throw new ConfigError(
      `Vault structure version ${version} is newer than this EnvVault build supports.`,
      "Upgrade EnvVault to open this vault.",
    );
  }

  const globals = normaliseSecretMap(raw.globals, "globals");
  const projects: VaultData["projects"] = {};

  const rawProjects = raw.projects;
  if (rawProjects !== undefined) {
    if (!isObject(rawProjects)) throw new ConfigError("Vault data is corrupt: projects is not an object.");
    for (const [projectName, projectValue] of Object.entries(rawProjects)) {
      if (!isObject(projectValue)) {
        throw new ConfigError(`Vault data is corrupt: project ${projectName} is not an object.`);
      }
      const shared = normaliseSecretMap(projectValue.shared, `projects.${projectName}.shared`);
      const environments: VaultData["projects"][string]["environments"] = {};
      const rawEnvironments = projectValue.environments;
      if (rawEnvironments !== undefined) {
        if (!isObject(rawEnvironments)) {
          throw new ConfigError(
            `Vault data is corrupt: projects.${projectName}.environments is not an object.`,
          );
        }
        for (const [envName, envValue] of Object.entries(rawEnvironments)) {
          if (!isObject(envValue)) {
            throw new ConfigError(
              `Vault data is corrupt: environment ${projectName}/${envName} is not an object.`,
            );
          }
          environments[envName] = {
            secrets: normaliseSecretMap(
              envValue.secrets,
              `projects.${projectName}.environments.${envName}.secrets`,
            ),
          };
        }
      }
      projects[projectName] = { shared, environments };
    }
  }

  return { version, globals, projects };
}

export function parseVaultPlaintext(plaintext: string): VaultData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new ConfigError("Vault decrypted successfully but its contents are not valid JSON.");
  }
  return validateVaultData(parsed);
}

export async function loadVault(home: string, password: string): Promise<VaultData> {
  const envelope = await readEnvelopeFile(home);
  return parseVaultPlaintext(await decryptVault(envelope, password));
}

export async function loadVaultWithKey(home: string, key: Buffer): Promise<VaultData> {
  const envelope = await readEnvelopeFile(home);
  return parseVaultPlaintext(decryptWithKey(envelope, key));
}

/** Encrypt and persist using an already-derived key (used by unlock sessions). */
export async function saveVaultWithKey(
  home: string,
  data: VaultData,
  vaultKey: VaultKey,
): Promise<void> {
  const envelope = encryptWithKey(JSON.stringify(data), vaultKey.key, vaultKey.salt);
  await writeEnvelopeFile(home, envelope);
}

async function existingSalt(home: string): Promise<Buffer | null> {
  try {
    const envelope = await readEnvelopeFile(home);
    return Buffer.from(envelope.salt, "base64");
  } catch {
    return null;
  }
}

/**
 * Encrypt and persist the vault.
 *
 * The salt from the existing vault is reused so a key derived once (for an
 * unlock session) stays valid across writes. Only the nonce changes.
 */
export async function saveVault(home: string, data: VaultData, password: string): Promise<void> {
  const salt = (await existingSalt(home)) ?? randomBytes(SALT_BYTES);
  const key = await deriveKey(password, salt);
  try {
    await writeEnvelopeFile(home, encryptWithKey(JSON.stringify(data), key, salt));
  } finally {
    wipe(key);
  }
}

export function assertValidProjectName(name: string): void {
  if (!PROJECT_NAME_PATTERN.test(name)) {
    throw new ConfigError(
      `Invalid project name: ${name}`,
      "Project names must start with a letter or digit and may contain letters, digits, dot, dash and underscore.",
    );
  }
}

export function hasProject(vault: VaultData, project: string): boolean {
  return Object.prototype.hasOwnProperty.call(vault.projects, project);
}

export function assertProject(vault: VaultData, project: string): void {
  if (!hasProject(vault, project)) throw new ProjectNotFoundError(project);
}

export function hasEnvironment(vault: VaultData, project: string, environment: string): boolean {
  const projectData = vault.projects[project];
  if (projectData === undefined) return false;
  return Object.prototype.hasOwnProperty.call(projectData.environments, environment);
}

export function assertEnvironment(vault: VaultData, project: string, environment: string): void {
  assertProject(vault, project);
  if (!hasEnvironment(vault, project, environment)) {
    throw new EnvironmentNotFoundError(project, environment);
  }
}

export function listProjects(vault: VaultData): string[] {
  return Object.keys(vault.projects).sort();
}

export function listEnvironments(vault: VaultData, project: string): string[] {
  assertProject(vault, project);
  return Object.keys(vault.projects[project]!.environments).sort();
}

export interface AddProjectResult {
  created: boolean;
  environment: string | undefined;
}

export function assertValidEnvironmentName(name: string): void {
  if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
    throw new ConfigError(
      `Invalid environment name: ${name}`,
      "Environment names must start with a letter or digit and may contain letters, digits, dot, dash and underscore.",
    );
  }
}

/**
 * Create an environment inside an existing project.
 * Returns `false` when the environment already exists.
 */
export function addEnvironment(vault: VaultData, project: string, environment: string): boolean {
  assertProject(vault, project);
  assertValidEnvironmentName(environment);
  const projectData = vault.projects[project]!;
  if (Object.prototype.hasOwnProperty.call(projectData.environments, environment)) return false;
  projectData.environments[environment] = { secrets: {} };
  return true;
}

export function addProject(
  vault: VaultData,
  project: string,
  environment?: string,
): AddProjectResult {
  assertValidProjectName(project);
  const existing = vault.projects[project];
  let created = false;
  if (existing === undefined) {
    vault.projects[project] = { shared: {}, environments: {} };
    created = true;
  }
  if (environment !== undefined && environment !== "") {
    addEnvironment(vault, project, environment);
  }
  return { created, environment };
}

export function removeProject(vault: VaultData, project: string): boolean {
  if (!hasProject(vault, project)) return false;
  delete vault.projects[project];
  return true;
}

export function scopeLabel(scope: SecretScope): string {
  switch (scope.kind) {
    case "global":
      return "global";
    case "project":
      return `${scope.project}/shared`;
    case "environment":
      return `${scope.project}/${scope.environment}`;
  }
}

function secretMapForScope(vault: VaultData, scope: SecretScope): Record<string, SecretEntry> {
  switch (scope.kind) {
    case "global":
      return vault.globals;
    case "project": {
      assertProject(vault, scope.project);
      return vault.projects[scope.project]!.shared;
    }
    case "environment": {
      assertEnvironment(vault, scope.project, scope.environment);
      return vault.projects[scope.project]!.environments[scope.environment]!.secrets;
    }
  }
}

export interface SetSecretResult {
  created: boolean;
  entry: SecretEntry;
}

export function setSecret(
  vault: VaultData,
  scope: SecretScope,
  name: string,
  value: string,
  options: { secret?: boolean } = {},
): SetSecretResult {
  const map = secretMapForScope(vault, scope);
  const existing = map[name];
  const now = nowIso();
  const secretFlag = options.secret === undefined ? {} : { secret: options.secret };
  const entry: SecretEntry =
    existing === undefined
      ? { value, createdAt: now, updatedAt: now, ...secretFlag }
      : { ...existing, value, updatedAt: now, ...secretFlag };
  map[name] = entry;
  return { created: existing === undefined, entry };
}

export function deleteSecret(vault: VaultData, scope: SecretScope, name: string): boolean {
  const map = secretMapForScope(vault, scope);
  if (!Object.prototype.hasOwnProperty.call(map, name)) return false;
  delete map[name];
  return true;
}

export function getSecretEntry(
  vault: VaultData,
  scope: SecretScope,
  name: string,
): SecretEntry | undefined {
  return secretMapForScope(vault, scope)[name];
}

export function countScopeSecrets(vault: VaultData, scope: SecretScope): number {
  return Object.keys(secretMapForScope(vault, scope)).length;
}
