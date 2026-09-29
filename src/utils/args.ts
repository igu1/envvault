/**
 * Minimal, dependency-free argument parser.
 *
 * EnvVault deliberately avoids a CLI framework so the published package can
 * carry zero runtime dependencies. The parser is intentionally small but
 * handles the two shapes the CLI needs:
 *
 *  - `parseArgs` for normal commands with flags anywhere.
 *  - `parseLeadingOptions` for pass-through commands (`run`, `docker run`,
 *    `docker compose`), where everything after the EnvVault flags belongs to
 *    the child command and must not be reinterpreted.
 */

import { UsageError } from "./errors";

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
  /** Tokens after a literal `--`. */
  rest: string[];
}

export function parseArgs(argv: readonly string[], booleans: readonly string[] = []): ParsedArgs {
  const boolSet = new Set(booleans);
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (body.startsWith("no-") && boolSet.has(body.slice(3))) {
        flags[body.slice(3)] = false;
        continue;
      }
      if (boolSet.has(body)) {
        flags[body] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[body] = next;
        i += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      flags[arg.slice(1)] = true;
      continue;
    }

    positionals.push(arg);
  }

  return { positionals, flags, rest };
}

export type OptionKind = "boolean" | "value";

export interface ExtractOptionsResult {
  options: Record<string, string | boolean>;
  rest: string[];
}

/**
 * Remove recognized `--flags` from anywhere in `tokens`, returning the
 * untouched remainder.
 *
 * Used by the pass-through Docker commands so EnvVault's own flags
 * (`--only`, `--service`, `--mode`) can appear before or after Docker's
 * arguments. Only flags explicitly listed in `spec` are removed; everything
 * else — including Docker's own `--env`, `-p`, `--rm` — is preserved in order.
 * A literal `--` stops extraction so it can still be used as an escape hatch.
 */
export function extractOptions(
  tokens: readonly string[],
  spec: Record<string, OptionKind>,
): ExtractOptionsResult {
  const options: Record<string, string | boolean> = {};
  const rest: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;

    if (token === "--") {
      rest.push(...tokens.slice(i));
      break;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      const key = eq >= 0 ? body.slice(0, eq) : body;
      const kind = spec[key];
      if (kind === "boolean") {
        options[key] = eq >= 0 ? body.slice(eq + 1) !== "false" : true;
        continue;
      }
      if (kind === "value") {
        if (eq >= 0) {
          options[key] = body.slice(eq + 1);
          continue;
        }
        const next = tokens[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          options[key] = next;
          i += 1;
        } else {
          options[key] = "";
        }
        continue;
      }
    }

    rest.push(token);
  }

  return { options, rest };
}

export interface LeadingOptions {
  options: Record<string, string | boolean>;
  /** Tokens after the recognized options (and after `--` when present). */
  rest: string[];
  usedTerminator: boolean;
}

/**
 * Consume a run of known `--flags` from the front of `tokens` and return the
 * untouched remainder. Stops at the first unknown token or `--`, so child
 * arguments (including flags like `-p 8000:8000`) pass through verbatim.
 */
export function parseLeadingOptions(
  tokens: readonly string[],
  spec: Record<string, OptionKind>,
): LeadingOptions {
  const options: Record<string, string | boolean> = {};
  let i = 0;
  let usedTerminator = false;

  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined) break;

    if (token === "--") {
      usedTerminator = true;
      i += 1;
      break;
    }

    if (!token.startsWith("--")) break;

    const body = token.slice(2);
    const eq = body.indexOf("=");
    const key = eq >= 0 ? body.slice(0, eq) : body;
    const kind = spec[key];
    if (kind === undefined) break;

    if (kind === "boolean") {
      options[key] = eq >= 0 ? body.slice(eq + 1) !== "false" : true;
      i += 1;
      continue;
    }

    if (eq >= 0) {
      options[key] = body.slice(eq + 1);
      i += 1;
      continue;
    }

    const next = tokens[i + 1];
    if (next === undefined) {
      options[key] = "";
      i += 1;
    } else {
      options[key] = next;
      i += 2;
    }
  }

  return { options, rest: tokens.slice(i), usedTerminator };
}

/** Read a required positional, throwing a usage error when absent. */
export function requirePositional(
  positionals: readonly string[],
  index: number,
  usage: string,
): string {
  const value = positionals[index];
  if (value === undefined || value === "") {
    throw new UsageError(usage);
  }
  return value;
}

export function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  const value = flags[name];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value !== "false" && value !== "0";
  return false;
}

export function flagNumber(
  flags: Record<string, string | boolean>,
  name: string,
): number | undefined {
  const value = flags[name];
  if (typeof value === "boolean") return undefined;
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function flagList(flags: Record<string, string | boolean>, name: string): string[] {
  const value = flags[name];
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function optionString(
  options: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

export function optionBool(options: Record<string, string | boolean>, name: string): boolean {
  return options[name] === true;
}

export function optionList(options: Record<string, string | boolean>, name: string): string[] {
  const value = options[name];
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
