/**
 * Remote control of the vault on a sharing server.
 *
 * A token with the `control` grant can list, read and change secrets, and
 * manage projects and environments, through one operation endpoint. Every
 * request and reply body is an envelope encrypted with a key derived from the
 * presented token and a fresh per-request salt, so values cross the network as
 * ciphertext even over plain HTTP — the same guarantee shares give.
 *
 * Operations act on the server's live vault. Writes are serialised so two
 * clients cannot interleave read-modify-write cycles on `vault.enc`.
 */

import { randomBytes } from "node:crypto";

import { decryptWithKey, deriveKey, encryptWithKey, parseEnvelope } from "../core/crypto";
import { resolveSecretDetails } from "../core/resolver";
import { readEnvelopeFile } from "../core/storage";
import {
  addEnvironment,
  addProject,
  assertEnvironment,
  assertProject,
  deleteSecret,
  listEnvironments,
  listProjects,
  loadVaultWithKey,
  removeProject,
  saveVaultWithKey,
  setSecret,
} from "../core/vault";
import type { EncryptedEnvelope, SecretScope, VaultData, VaultKey } from "../core/types";
import { ConfigError, UsageError } from "../utils/errors";

/** Largest value a remote write may carry; matches the CLI's practical limit. */
export const MAX_CONTROL_VALUE_BYTES = 64 * 1024;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type ControlOperation =
  | { op: "projects" }
  | { op: "list"; scope: SecretScope }
  | { op: "export"; scope: SecretScope }
  | { op: "get"; scope: SecretScope; name: string }
  | { op: "set"; scope: SecretScope; name: string; value: string }
  | { op: "delete"; scope: SecretScope; name: string }
  | { op: "addProject"; project: string; environment?: string }
  | { op: "addEnvironment"; project: string; environment: string }
  | { op: "removeProject"; project: string };

export interface ControlListRow {
  name: string;
  origin: "global" | "project" | "environment";
  value: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value === "") {
    throw new UsageError(`Remote request is missing "${field}".`);
  }
  if (pattern !== undefined && !pattern.test(value)) {
    throw new UsageError(`Remote request has an invalid "${field}".`);
  }
  return value;
}

function parseScope(raw: unknown): SecretScope {
  if (!isRecord(raw)) throw new UsageError('Remote request is missing "scope".');
  switch (raw.kind) {
    case "global":
      return { kind: "global" };
    case "project":
      return { kind: "project", project: requireString(raw.project, "project", PROJECT_PATTERN) };
    case "environment":
      return {
        kind: "environment",
        project: requireString(raw.project, "project", PROJECT_PATTERN),
        environment: requireString(raw.environment, "environment", PROJECT_PATTERN),
      };
    default:
      throw new UsageError('Remote scope kind must be "global", "project" or "environment".');
  }
}

/** Validate an untrusted decrypted request body. */
export function parseControlOperation(raw: unknown): ControlOperation {
  if (!isRecord(raw)) throw new UsageError("Remote request must be a JSON object.");
  switch (raw.op) {
    case "projects":
      return { op: "projects" };
    case "list":
      return { op: "list", scope: parseScope(raw.scope) };
    case "export":
      return { op: "export", scope: parseScope(raw.scope) };
    case "get":
      return { op: "get", scope: parseScope(raw.scope), name: requireString(raw.name, "name", NAME_PATTERN) };
    case "delete":
      return { op: "delete", scope: parseScope(raw.scope), name: requireString(raw.name, "name", NAME_PATTERN) };
    case "set": {
      const value = raw.value;
      if (typeof value !== "string") throw new UsageError('Remote request is missing "value".');
      if (Buffer.byteLength(value, "utf8") > MAX_CONTROL_VALUE_BYTES) {
        throw new UsageError("Secret value is too large for a remote write.");
      }
      return {
        op: "set",
        scope: parseScope(raw.scope),
        name: requireString(raw.name, "name", NAME_PATTERN),
        value,
      };
    }
    case "addProject":
      return {
        op: "addProject",
        project: requireString(raw.project, "project", PROJECT_PATTERN),
        ...(raw.environment === undefined
          ? {}
          : { environment: requireString(raw.environment, "environment", PROJECT_PATTERN) }),
      };
    case "addEnvironment":
      return {
        op: "addEnvironment",
        project: requireString(raw.project, "project", PROJECT_PATTERN),
        environment: requireString(raw.environment, "environment", PROJECT_PATTERN),
      };
    case "removeProject":
      return { op: "removeProject", project: requireString(raw.project, "project", PROJECT_PATTERN) };
    default:
      throw new UsageError(`Unknown remote operation: ${String(raw.op)}`);
  }
}

/** Secret rows for a scope, with origins, mirroring `envvault list`. */
export function scopeRows(vault: VaultData, scope: SecretScope): ControlListRow[] {
  switch (scope.kind) {
    case "global":
      return Object.entries(vault.globals).map(([name, entry]) => ({ name, origin: "global", value: entry.value }));
    case "project":
      return Object.entries(vault.projects[scope.project]?.shared ?? {}).map(([name, entry]) => ({
        name,
        origin: "project",
        value: entry.value,
      }));
    case "environment":
      return resolveSecretDetails(vault, { project: scope.project, environment: scope.environment }).map(
        (secret) => ({ name: secret.name, origin: secret.origin, value: secret.value }),
      );
  }
}

function assertScopeExists(vault: VaultData, scope: SecretScope): void {
  if (scope.kind === "global") return;
  assertProject(vault, scope.project);
  if (scope.kind === "environment") assertEnvironment(vault, scope.project, scope.environment);
}

/** Serialise every operation: reads are cheap, writes must not interleave. */
let chain: Promise<unknown> = Promise.resolve();
function serialise<T>(task: () => Promise<T>): Promise<T> {
  const next = chain.then(task, task);
  chain = next.catch(() => undefined);
  return next;
}

/**
 * Run one validated operation against the vault in `home`. Returns a plain
 * JSON-compatible result; values are only ever returned for `list`, `export`
 * and `get`, and those results are encrypted by the caller.
 */
export async function runControlOperation(
  home: string,
  vaultKey: Buffer,
  operation: ControlOperation,
): Promise<unknown> {
  return await serialise(async () => {
    const vault = await loadVaultWithKey(home, vaultKey);
    const keyPair = await vaultKeyPair(home, vaultKey);

    switch (operation.op) {
      case "projects":
        return {
          globalSecretCount: Object.keys(vault.globals).length,
          projects: listProjects(vault).map((name) => ({
            name,
            sharedSecretCount: Object.keys(vault.projects[name]!.shared).length,
            environments: listEnvironments(vault, name).map((environment) => ({
              name: environment,
              secretCount: Object.keys(vault.projects[name]!.environments[environment]!.secrets).length,
            })),
          })),
        };

      case "list":
        assertScopeExists(vault, operation.scope);
        return { rows: scopeRows(vault, operation.scope) };

      case "export": {
        assertScopeExists(vault, operation.scope);
        const secrets: Record<string, string> = {};
        for (const row of scopeRows(vault, operation.scope)) secrets[row.name] = row.value;
        return { secrets };
      }

      case "get": {
        assertScopeExists(vault, operation.scope);
        const row = scopeRows(vault, operation.scope).find((candidate) => candidate.name === operation.name);
        return row === undefined ? { found: false } : { found: true, value: row.value };
      }

      case "set":
        assertScopeExists(vault, operation.scope);
        setSecret(vault, operation.scope, operation.name, operation.value);
        await saveVaultWithKey(home, vault, keyPair);
        return { ok: true };

      case "delete": {
        assertScopeExists(vault, operation.scope);
        const removed = deleteSecret(vault, operation.scope, operation.name);
        if (removed) await saveVaultWithKey(home, vault, keyPair);
        return { deleted: removed };
      }

      case "addProject": {
        const result = addProject(vault, operation.project, operation.environment);
        await saveVaultWithKey(home, vault, keyPair);
        return { ok: true, result };
      }

      case "addEnvironment": {
        const created = addEnvironment(vault, operation.project, operation.environment);
        if (created) await saveVaultWithKey(home, vault, keyPair);
        return { created };
      }

      case "removeProject": {
        const removed = removeProject(vault, operation.project);
        if (removed) await saveVaultWithKey(home, vault, keyPair);
        return { removed };
      }
    }
  });
}

/** The server holds the derived key; the vault file supplies its salt. */
async function vaultKeyPair(home: string, key: Buffer): Promise<VaultKey> {
  const envelope = await readEnvelopeFile(home);
  return { key, salt: Buffer.from(envelope.salt, "base64") };
}

/** Decrypt a control request body with the token-derived key for its salt. */
export async function openControlBody(
  presentedToken: string,
  raw: unknown,
): Promise<{ operation: ControlOperation; key: Buffer; salt: Buffer }> {
  let envelope: EncryptedEnvelope;
  try {
    envelope = parseEnvelope(raw);
  } catch {
    throw new ConfigError("The remote request is not a valid encrypted envelope.");
  }
  const salt = Buffer.from(envelope.salt, "base64");
  const key = await deriveKey(presentedToken, salt);
  let plaintext: string;
  try {
    plaintext = decryptWithKey(envelope, key);
  } catch {
    throw new ConfigError("The remote request could not be decrypted with this token.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new UsageError("The remote request is not valid JSON.");
  }
  return { operation: parseControlOperation(parsed), key, salt };
}

/** Encrypt a reply under the same key and salt as the request it answers. */
export function sealControlReply(result: unknown, key: Buffer, salt: Buffer): EncryptedEnvelope {
  return encryptWithKey(JSON.stringify(result), key, salt);
}

/** Fresh salt for a client request. Exported for the client and tests. */
export function newControlSalt(): Buffer {
  return randomBytes(16);
}
