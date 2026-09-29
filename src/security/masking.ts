/**
 * Centralized secret masking.
 *
 * Every place that renders a secret must go through this module. Full masking
 * is the default; partial masking is only used where a hint is genuinely
 * useful and the value is low-sensitivity.
 */

const DOT = "•";
const MIN_DOTS = 8;
const MAX_DOTS = 20;

/** Fully mask a value: `sk-123` -> `••••••••`. */
export function maskSecret(value: string): string {
  const length = value.length === 0 ? MIN_DOTS : Math.min(Math.max(value.length, MIN_DOTS), MAX_DOTS);
  return DOT.repeat(length);
}

/** Show a short prefix/suffix for identification: `sk-…-abc123` -> `sk••••••123`. */
export function maskPartial(value: string): string {
  if (value.length <= 8) return maskSecret(value);
  return `${value.slice(0, 2)}${DOT.repeat(6)}${value.slice(-3)}`;
}

/** True when a string is entirely masking dots (used defensively in tests). */
export function isMasked(value: string): boolean {
  return value.length > 0 && /^•+$/.test(value);
}
