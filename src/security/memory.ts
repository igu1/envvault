import { maskSecret } from "./masking";

/**
 * Best-effort memory hygiene helpers.
 *
 * JavaScript strings are immutable and cannot be reliably wiped, so we cannot
 * guarantee secrets are removed from memory. What we *can* do is wipe the
 * derived key buffers we control and avoid ever stringifying secret objects.
 */

/** Overwrite one or more buffers with zeroes. */
export function wipe(...buffers: Array<Buffer | Uint8Array | undefined | null>): void {
  for (const buffer of buffers) {
    if (buffer === undefined || buffer === null) continue;
    buffer.fill(0);
  }
}

/**
 * A string wrapper that refuses to reveal itself accidentally.
 *
 * `toString`, `toJSON` and Node's console inspection all return a mask, so a
 * `SecretValue` can be logged or embedded in an error without leaking.
 */
export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  get length(): number {
    return this.#value.length;
  }

  /** Explicit opt-in to the plaintext. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return maskSecret(this.#value);
  }

  toJSON(): string {
    return maskSecret(this.#value);
  }

  toPrimitive(): string {
    return maskSecret(this.#value);
  }
}

/** Build a masked view of a secrets map, safe to log. */
export function maskRecord(secrets: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [name, value] of Object.entries(secrets)) {
    masked[name] = maskSecret(value);
  }
  return masked;
}
