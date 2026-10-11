/**
 * Client side of remote control. Encrypts each operation with a key derived
 * from the token and a fresh salt, then decrypts the reply with the same key.
 */

import { decryptWithKey, deriveKey, encryptWithKey, parseEnvelope } from "../core/crypto";
import { ConfigError } from "../utils/errors";
import { newControlSalt } from "./control";
import { serverRequest } from "./client";
import type { ControlOperation } from "./control";

/** Remote writes can take a moment: the server runs scrypt once per request. */
const CONTROL_TIMEOUT_MS = 30_000;

export async function sendControlOperation<T>(
  baseUrl: string,
  token: string,
  operation: ControlOperation,
): Promise<T> {
  const salt = newControlSalt();
  const key = await deriveKey(token, salt);
  const envelope = encryptWithKey(JSON.stringify(operation), key, salt);

  const response = await serverRequest<{ envelope?: unknown }>(baseUrl, "/control", {
    method: "POST",
    token,
    body: { envelope },
    timeoutMs: CONTROL_TIMEOUT_MS,
  });

  if (response?.envelope === undefined) {
    throw new ConfigError("The server returned an empty control reply.");
  }
  let plaintext: string;
  try {
    plaintext = decryptWithKey(parseEnvelope(response.envelope), key);
  } catch {
    throw new ConfigError("The server reply could not be decrypted with this token.");
  }
  return JSON.parse(plaintext) as T;
}
