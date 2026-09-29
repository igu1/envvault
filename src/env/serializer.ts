/**
 * Serializers for `envvault export`.
 *
 * All three formats emit plaintext, which is why export is always an explicit
 * user action.
 */

export type ExportFormat = "env" | "json" | "shell";

export const EXPORT_FORMATS: readonly ExportFormat[] = ["env", "json", "shell"];

export function serializeEnv(secrets: Record<string, string>): string {
  const lines = Object.keys(secrets)
    .sort()
    .map((name) => `${name}=${encodeEnvValue(secrets[name] as string)}`);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function serializeJson(secrets: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const name of Object.keys(secrets).sort()) {
    sorted[name] = secrets[name] as string;
  }
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

export function serializeShell(secrets: Record<string, string>): string {
  const lines = Object.keys(secrets)
    .sort()
    .map((name) => `export ${name}=${shellQuote(secrets[name] as string)}`);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function serializeSecrets(
  secrets: Record<string, string>,
  format: ExportFormat,
): string {
  switch (format) {
    case "json":
      return serializeJson(secrets);
    case "shell":
      return serializeShell(secrets);
    case "env":
    default:
      return serializeEnv(secrets);
  }
}

/** Quote an `.env` value only when it would otherwise be ambiguous. */
export function encodeEnvValue(value: string): string {
  if (value === "") return '""';
  if (!/[\s"'#$`\\]/.test(value)) return value;
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\$/g, "\\$");
  return `"${escaped}"`;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
