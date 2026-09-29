/**
 * Share payload construction, encryption and decryption.
 *
 * A share is a project/environment plus an allowlist of key names. The server
 * resolves the allowlisted values from the live vault and encrypts them with a
 * key derived from the recipient's share token, reusing the vault's
 * AES-256-GCM + scrypt envelope. The salt carried in the envelope is the
 * token's salt, so a client that holds the token can derive the same key
 * without any out-of-band salt exchange.
 */

import { decryptWithKey, deriveKey, encryptWithKey, parseEnvelope } from "../core/crypto";
import { resolveSecret } from "../core/resolver";
import { ConfigError } from "../utils/errors";
import type { EncryptedEnvelope, VaultData } from "../core/types";
import type { ShareDefinition, SharePayload } from "./types";

/** Resolve the allowlisted names for a share. Missing names are reported, not fatal. */
export function buildSharePayload(
  vault: VaultData,
  share: ShareDefinition,
  exportedAt: string,
): SharePayload {
  const context = { project: share.project, environment: share.environment };
  const secrets: Record<string, string> = {};
  const missing: string[] = [];

  for (const name of share.keys) {
    const resolved = resolveSecret(vault, context, name);
    if (resolved === undefined) {
      missing.push(name);
    } else {
      secrets[name] = resolved.value;
    }
  }

  const payload: SharePayload = {
    project: share.project,
    environment: share.environment,
    exportedAt,
    secrets,
    missing,
  };
  if (share.label !== undefined) payload.label = share.label;
  return payload;
}

/** Encrypt a payload with a token-derived key and the token's salt. */
export function encryptSharePayload(
  payload: SharePayload,
  key: Buffer,
  salt: Buffer,
): EncryptedEnvelope {
  return encryptWithKey(JSON.stringify(payload), key, salt);
}

/** Derive the share key from a token and the salt embedded in the envelope. */
export async function deriveShareKeyFromEnvelope(
  envelope: EncryptedEnvelope,
  token: string,
): Promise<Buffer> {
  return await deriveKey(token, Buffer.from(envelope.salt, "base64"));
}

/** Decrypt and validate a share envelope using the raw token. */
export async function decryptShareEnvelope(
  raw: unknown,
  token: string,
): Promise<SharePayload> {
  const envelope = parseEnvelope(raw);
  const key = await deriveShareKeyFromEnvelope(envelope, token);
  let plaintext: string;
  try {
    plaintext = decryptWithKey(envelope, key);
  } catch {
    throw new ConfigError(
      "Could not decrypt the share. The token is wrong or the payload was modified.",
    );
  }
  return parseSharePayload(plaintext);
}

export function parseSharePayload(plaintext: string): SharePayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new ConfigError("The share decrypted but its contents are not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ConfigError("The share payload is not an object.");
  }
  const candidate = parsed as Record<string, unknown>;

  if (typeof candidate.project !== "string" || typeof candidate.environment !== "string") {
    throw new ConfigError("The share payload is missing its project/environment.");
  }
  if (
    typeof candidate.secrets !== "object" ||
    candidate.secrets === null ||
    Array.isArray(candidate.secrets)
  ) {
    throw new ConfigError("The share payload has no secrets object.");
  }

  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(candidate.secrets as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new ConfigError(`The share payload has a non-string value for ${name}.`);
    }
    secrets[name] = value;
  }

  const missing = Array.isArray(candidate.missing)
    ? (candidate.missing as unknown[]).filter((item): item is string => typeof item === "string")
    : [];

  const payload: SharePayload = {
    project: candidate.project,
    environment: candidate.environment,
    exportedAt: typeof candidate.exportedAt === "string" ? candidate.exportedAt : "",
    secrets,
    missing,
  };
  if (typeof candidate.label === "string") payload.label = candidate.label;
  return payload;
}
