/**
 * Share tokens.
 *
 * A token is the only thing a client needs to read and decrypt a share. The
 * server derives an AES key from it with scrypt and stores only that key plus
 * the salt — never the token itself. Authentication and payload encryption
 * therefore use the same derived key, and a passive observer on the network
 * sees ciphertext only.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

import { AuthError } from "../utils/errors";
import { deriveKey } from "../core/crypto";
import { SERVER_TOKEN_PREFIX } from "./types";
import type { ServerConfig, ServerToken, TokenGrant } from "./types";

/** 32 bytes of entropy, base64url encoded, with a recognisable prefix. */
export function generateShareToken(): string {
  return `${SERVER_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function generateTokenId(): string {
  return randomBytes(6).toString("hex");
}

/** Derive the AES key for a token and salt (both base64 handled by callers). */
export async function deriveTokenKey(token: string, salt: Buffer): Promise<Buffer> {
  return await deriveKey(token, salt);
}

export interface CreatedToken {
  /** Shown to the user exactly once. */
  token: string;
  record: ServerToken;
}

/** Create a token record. The raw token is returned but never stored. */
export async function createToken(
  label: string,
  grant: TokenGrant,
  createdAt: string,
): Promise<CreatedToken> {
  const token = generateShareToken();
  const salt = randomBytes(16);
  const key = await deriveTokenKey(token, salt);
  return {
    token,
    record: {
      id: generateTokenId(),
      label,
      key: key.toString("base64"),
      salt: salt.toString("base64"),
      grant,
      createdAt,
    },
  };
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface AuthenticatedToken {
  token: ServerToken;
  /** Derived key, valid for encrypting/decrypting that token's payloads. */
  key: Buffer;
}

/**
 * Match a presented token against every configured token.
 *
 * The scan is not early-exiting on the derived key, but scrypt dominates the
 * cost, and a local, opt-in server is the target deployment.
 */
export async function authenticateToken(
  config: ServerConfig,
  presented: string | undefined,
): Promise<AuthenticatedToken | null> {
  if (presented === undefined || presented === "") return null;

  for (const token of config.tokens) {
    const salt = Buffer.from(token.salt, "base64");
    const derived = await deriveTokenKey(presented, salt);
    if (safeEqual(derived, Buffer.from(token.key, "base64"))) {
      return { token, key: derived };
    }
  }
  return null;
}

/** Constant-time check, used by tests and the client-side verifier. */
export function tokensMatch(a: Buffer, b: Buffer): boolean {
  return safeEqual(a, b);
}

/** Extract a bearer token from an Authorization header value. */
export function bearerFrom(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) return undefined;
  const value = match[1];
  if (value === undefined || value.trim() === "") return undefined;
  return value.trim();
}

export function assertTokenShape(token: string): void {
  if (!token.startsWith(SERVER_TOKEN_PREFIX) || token.length < SERVER_TOKEN_PREFIX.length + 16) {
    throw new AuthError(
      "That does not look like an EnvVault share token.",
      `Tokens start with "${SERVER_TOKEN_PREFIX}".`,
    );
  }
}
