/**
 * Authenticated encryption for the vault.
 *
 * Scheme (envelope version 1):
 *
 *   master password -> scrypt -> 256-bit key -> AES-256-GCM -> vault.enc
 *
 * Only Node's built-in `crypto` is used. Base64 appears in the envelope as an
 * *encoding* for binary fields; it is never used as a substitute for
 * encryption.
 */

import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from "node:crypto";
import type { ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

import { AuthError, ConfigError, WrongPasswordError } from "../utils/errors";
import { wipe } from "../security/memory";
import { CURRENT_ENVELOPE_VERSION } from "./types";
import type { EncryptedEnvelope } from "./types";

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

export const ENVELOPE_VERSION = CURRENT_ENVELOPE_VERSION;
export const ALGORITHM = "aes-256-gcm";
export const KDF = "scrypt";
export const KEY_BYTES = 32;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;

/**
 * scrypt parameters. `maxmem` must exceed 128 * N * r bytes, otherwise Node
 * throws; we give it comfortable headroom.
 */
export const SCRYPT_PARAMS: ScryptOptions = {
  N: 1 << 15,
  r: 8,
  p: 1,
  maxmem: 128 * 1024 * 1024,
};

export async function deriveKey(
  password: string,
  salt: Buffer,
  params: ScryptOptions = SCRYPT_PARAMS,
): Promise<Buffer> {
  return await scrypt(password, salt, KEY_BYTES, params);
}

/** Encrypt plaintext with a fresh random salt. Use `saveVault` for a stable salt. */
export async function encryptVault(
  plaintext: string,
  password: string,
): Promise<EncryptedEnvelope> {
  assertPassword(password);
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(password, salt);
  try {
    return encryptWithKey(plaintext, key, salt);
  } finally {
    wipe(key);
  }
}

/**
 * Encrypt with an already-derived key and a caller-provided salt.
 *
 * The salt is reused across writes (see `saveVault`) so that a key derived
 * once stays valid; only the nonce is regenerated, which is what AES-GCM
 * requires. Reusing a salt with scrypt is safe — the salt only needs to be
 * unique per vault, not per write.
 */
export function encryptWithKey(
  plaintext: string,
  key: Buffer,
  salt: Buffer,
): EncryptedEnvelope {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: ENVELOPE_VERSION,
    kdf: KDF,
    cipher: ALGORITHM,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/**
 * Decrypt an envelope using a password. A GCM authentication failure is
 * deliberately surfaced as `WrongPasswordError`: it covers both a wrong
 * password and a tampered file, and we must not leak which one occurred.
 */
export async function decryptVault(
  envelope: EncryptedEnvelope,
  password: string,
): Promise<string> {
  assertPassword(password);
  const salt = Buffer.from(envelope.salt, "base64");
  const key = await deriveKey(password, salt);
  try {
    return decryptWithKey(envelope, key);
  } finally {
    wipe(key);
  }
}

/** Decrypt an envelope with an already-derived key. Synchronous and pure. */
export function decryptWithKey(envelope: EncryptedEnvelope, key: Buffer): string {
  assertKey(key);
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new WrongPasswordError(
      "Could not decrypt the vault. The master password is incorrect or the vault was modified.",
    );
  }
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new AuthError("Invalid vault key.");
  }
}

function assertPassword(password: string): void {
  if (typeof password !== "string" || password.length === 0) {
    throw new AuthError("A master password is required.");
  }
}

/**
 * Validate untrusted JSON into an `EncryptedEnvelope`. Called before any
 * decryption so a malformed file fails safely instead of throwing deep in
 * crypto code.
 */
export function parseEnvelope(raw: unknown): EncryptedEnvelope {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError("Vault file is not a valid EnvVault envelope.");
  }
  const candidate = raw as Record<string, unknown>;

  const version = candidate.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new ConfigError("Vault file has an invalid format version.");
  }
  if (version > ENVELOPE_VERSION) {
    throw new ConfigError(
      `Vault format version ${version} is newer than this EnvVault build supports (${ENVELOPE_VERSION}).`,
      "Upgrade EnvVault to open this vault.",
    );
  }
  if (candidate.kdf !== KDF) {
    throw new ConfigError(`Unsupported key derivation function: ${String(candidate.kdf)}`);
  }
  if (candidate.cipher !== ALGORITHM) {
    throw new ConfigError(`Unsupported cipher: ${String(candidate.cipher)}`);
  }

  const required = ["salt", "iv", "tag", "ciphertext"] as const;
  for (const field of required) {
    if (typeof candidate[field] !== "string") {
      throw new ConfigError(`Vault file is missing the "${field}" field.`);
    }
  }

  return {
    version,
    kdf: KDF,
    cipher: ALGORITHM,
    salt: candidate.salt as string,
    iv: candidate.iv as string,
    tag: candidate.tag as string,
    ciphertext: candidate.ciphertext as string,
  };
}
