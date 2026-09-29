/** Parse and format short durations such as `30m`, `8h`, `7d`. */

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

const UNIT_ORDER: Array<[string, number]> = [
  ["w", UNIT_MS.w as number],
  ["d", UNIT_MS.d as number],
  ["h", UNIT_MS.h as number],
  ["m", UNIT_MS.m as number],
  ["s", UNIT_MS.s as number],
];

/** Parse `30s`, `15m`, `8h`, `7d`, `2w` into milliseconds. Returns null if invalid. */
export function parseDuration(text: string): number | null {
  const match = /^(\d+)\s*(s|m|h|d|w)?$/i.exec(text.trim());
  if (match === null) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] ?? "s").toLowerCase();
  const factor = UNIT_MS[unit];
  if (factor === undefined) return null;
  return value * factor;
}

/** Human-friendly duration, e.g. `8 hours`, `1 day`, `90 minutes`. */
export function formatDuration(ms: number): string {
  for (const [label, unitMs] of UNIT_ORDER) {
    if (ms % unitMs === 0 && ms >= unitMs) {
      const value = ms / unitMs;
      const name = label === "w" ? "week" : label === "d" ? "day" : label === "h" ? "hour" : label === "m" ? "minute" : "second";
      return `${value} ${name}${value === 1 ? "" : "s"}`;
    }
  }
  return `${Math.round(ms / 1000)} seconds`;
}
