/**
 * Tiny terminal output helpers.
 *
 * Colors are only emitted when stdout is a TTY and NO_COLOR is unset, so
 * piped output and tests always receive clean text.
 */

const colorEnabled = (): boolean =>
  process.env.NO_COLOR === undefined &&
  process.env.FORCE_COLOR !== "0" &&
  process.stdout.isTTY === true;

function wrap(open: number, close: number): (text: string) => string {
  return (text: string) => (colorEnabled() ? `\u001b[${open}m${text}\u001b[${close}m` : text);
}

export const style = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
};

export const symbols = {
  check: "✓",
  cross: "✗",
  warn: "⚠",
} as const;

export function formatSuccess(message: string): string {
  return `${style.green(symbols.check)} ${message}`;
}

export function formatFailure(message: string): string {
  return `${style.red(symbols.cross)} ${message}`;
}

export function formatWarning(message: string): string {
  return `${style.yellow(symbols.warn)} Warning: ${message}`;
}

/** Pad a secret name so masked columns line up. */
export function padName(name: string, width = 20): string {
  return name.length >= width ? name : name.padEnd(width);
}
