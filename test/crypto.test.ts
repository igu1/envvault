import { describe, expect, it } from "vitest";

import { decryptVault, encryptVault, parseEnvelope } from "../src/core/crypto";
import { ConfigError, WrongPasswordError } from "../src/utils/errors";

const PASSWORD = "correct-horse-battery-staple";

describe("crypto/encryptVault+decryptVault", () => {
  it("round trips plaintext", async () => {
    const plaintext = JSON.stringify({ hello: "world", nested: { value: "42" } });
    const envelope = await encryptVault(plaintext, PASSWORD);
    await expect(decryptVault(envelope, PASSWORD)).resolves.toBe(plaintext);
  });

  it("fails with the wrong password", async () => {
    const envelope = await encryptVault("super-secret", PASSWORD);
    await expect(decryptVault(envelope, "not-the-password")).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });

  it("fails when the ciphertext is tampered with", async () => {
    const envelope = await encryptVault("super-secret", PASSWORD);
    const bytes = Buffer.from(envelope.ciphertext, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    await expect(
      decryptVault({ ...envelope, ciphertext: bytes.toString("base64") }, PASSWORD),
    ).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("fails when the authentication tag is tampered with", async () => {
    const envelope = await encryptVault("super-secret", PASSWORD);
    const bytes = Buffer.from(envelope.tag, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    await expect(
      decryptVault({ ...envelope, tag: bytes.toString("base64") }, PASSWORD),
    ).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("uses a fresh salt and nonce for every encryption", async () => {
    const first = await encryptVault("same-input", PASSWORD);
    const second = await encryptVault("same-input", PASSWORD);
    expect(first.salt).not.toBe(second.salt);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("never includes plaintext in the envelope", async () => {
    const secret = "sk-live-1234567890-do-not-leak";
    const envelope = await encryptVault(JSON.stringify({ OPENAI_API_KEY: secret }), PASSWORD);
    expect(JSON.stringify(envelope)).not.toContain(secret);
  });

  it("requires a non-empty password", async () => {
    await expect(encryptVault("data", "")).rejects.toThrow();
  });
});

describe("crypto/parseEnvelope", () => {
  it("rejects non-objects", () => {
    expect(() => parseEnvelope(null)).toThrow(ConfigError);
    expect(() => parseEnvelope("nope")).toThrow(ConfigError);
    expect(() => parseEnvelope(42)).toThrow(ConfigError);
  });

  it("rejects missing fields", () => {
    expect(() =>
      parseEnvelope({ version: 1, kdf: "scrypt", cipher: "aes-256-gcm" }),
    ).toThrow(ConfigError);
  });

  it("rejects unsupported algorithms", () => {
    expect(() =>
      parseEnvelope({
        version: 1,
        kdf: "scrypt",
        cipher: "aes-128-ecb",
        salt: "a",
        iv: "b",
        tag: "c",
        ciphertext: "d",
      }),
    ).toThrow(ConfigError);
  });

  it("rejects a newer format version instead of guessing", () => {
    expect(() =>
      parseEnvelope({
        version: 99,
        kdf: "scrypt",
        cipher: "aes-256-gcm",
        salt: "a",
        iv: "b",
        tag: "c",
        ciphertext: "d",
      }),
    ).toThrow(ConfigError);
  });

  it("accepts a well-formed envelope", async () => {
    const envelope = await encryptVault("data", PASSWORD);
    expect(parseEnvelope(envelope)).toEqual(envelope);
  });
});
