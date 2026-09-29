/**
 * `.env` parser.
 *
 * Supports the common dotenv syntax:
 *   KEY=value
 *   KEY="quoted value"
 *   KEY='literal $value'
 *   export KEY=value
 *   # comments and blank lines
 *   inline comments on unquoted values
 *   equals signs and `#` inside values
 *
 * Deliberately does NOT evaluate shell expressions. `$(...)`, backticks and
 * variable expansion are treated as literal text. Importing a `.env` must
 * never execute code.
 */

export interface ParsedEnvEntry {
  key: string;
  value: string;
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidEnvKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export function parseEnv(content: string): ParsedEnvEntry[] {
  const entries: ParsedEnvEntry[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    let body = line;
    if (body.startsWith("export ")) body = body.slice("export ".length).trimStart();

    const equals = body.indexOf("=");
    if (equals <= 0) continue;

    const key = body.slice(0, equals).trim();
    if (!isValidEnvKey(key)) continue;

    entries.push({ key, value: parseValue(body.slice(equals + 1)) });
  }

  return entries;
}

function parseValue(raw: string): string {
  const value = raw.trim();
  if (value === "") return "";

  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = findClosingQuote(value, quote);
    const inner = end === -1 ? value.slice(1) : value.slice(1, end);
    return quote === '"' ? expandDoubleQuoted(inner) : inner;
  }

  return stripInlineComment(value).trimEnd();
}

function findClosingQuote(value: string, quote: string): number {
  for (let i = 1; i < value.length; i += 1) {
    const char = value[i];
    if (quote === '"' && char === "\\") {
      i += 1;
      continue;
    }
    if (char === quote) return i;
  }
  return -1;
}

function expandDoubleQuoted(input: string): string {
  let output = "";
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char !== "\\" || i + 1 >= input.length) {
      output += char;
      continue;
    }
    const next = input[i + 1] as string;
    i += 1;
    switch (next) {
      case "n":
        output += "\n";
        break;
      case "r":
        output += "\r";
        break;
      case "t":
        output += "\t";
        break;
      case '"':
        output += '"';
        break;
      case "\\":
        output += "\\";
        break;
      case "$":
        output += "$";
        break;
      default:
        // Unknown escape: keep the escaped character literally.
        output += next;
        break;
    }
  }
  return output;
}

function stripInlineComment(value: string): string {
  let output = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i] as string;
    if (char === "\\" && i + 1 < value.length) {
      output += char + (value[i + 1] as string);
      i += 1;
      continue;
    }
    if (char === "#" && (i === 0 || /\s/.test(value[i - 1] as string))) break;
    output += char;
  }
  return output;
}
