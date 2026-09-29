/**
 * Source scanner for `envvault doctor`.
 *
 * Extracts environment-variable *names* referenced in a project so they can be
 * compared against the vault. Only names are ever collected; values are never
 * read or emitted.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";

import { parseEnv } from "./parser";

export interface EnvReference {
  name: string;
  /** Path relative to the scanned root. */
  file: string;
  line: number;
}

export interface ScanOptions {
  extensions?: readonly string[];
  ignoreDirs?: readonly string[];
  maxFileBytes?: number;
}

export const DEFAULT_SOURCE_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".py",
  ".go",
  ".rs",
  ".php",
  ".java",
  ".kt",
  ".kts",
  ".rb",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
];

export const DEFAULT_IGNORE_DIRS: readonly string[] = [
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".envvault",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "vendor",
  "target",
];

/**
 * Variables that are provided by the OS/shell/runtime and should never be
 * reported as missing from the vault.
 */
export const IGNORED_ENV_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "SHELL",
  "USER",
  "LOGNAME",
  "TERM",
  "TERM_PROGRAM",
  "COLORTERM",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "HOSTNAME",
  "HOST",
  "TMPDIR",
  "TEMP",
  "TMP",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "NODE_ENV",
  "NODE_OPTIONS",
  "CI",
  "DEBUG",
  "_",
]);

const CODE_PATTERNS: readonly RegExp[] = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\[\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\]/g,
  /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /import\.meta\.env\[\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\]/g,
  /os\.environ\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /os\.environ\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /os\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /Getenv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
  /std::env::var\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
  /System\.getenv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
  /\benv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/g,
];

const SHELL_PATTERNS: readonly RegExp[] = [
  /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
  /\$([A-Za-z_][A-Za-z0-9_]*)/g,
];

const DOCKERFILE_PATTERN = /^\s*(?:ARG|ENV)\s+([A-Za-z_][A-Za-z0-9_]*)/;

function isEnvFile(name: string): boolean {
  return name === ".env" || name.startsWith(".env.") || name.endsWith(".env");
}

function isDockerfile(name: string): boolean {
  return name === "Dockerfile" || name.startsWith("Dockerfile.");
}

function isShellFile(name: string): boolean {
  return [".sh", ".bash", ".zsh", ".fish"].includes(extname(name));
}

function shouldScan(name: string, extensions: readonly string[]): boolean {
  if (isEnvFile(name) || isDockerfile(name)) return true;
  return extensions.includes(extname(name));
}

function addReference(
  references: Map<string, EnvReference>,
  name: string,
  file: string,
  line: number,
): void {
  if (name.length === 0) return;
  if (IGNORED_ENV_NAMES.has(name)) return;
  if (name.startsWith("npm_")) return;
  const key = `${file}:${line}:${name}`;
  if (!references.has(key)) references.set(key, { name, file, line });
}

/** Extract env references from a single file's contents. */
export function extractEnvNames(source: string, file: string): EnvReference[] {
  const references = new Map<string, EnvReference>();
  const lines = source.split(/\r?\n/);
  const fileName = basename(file);

  if (isEnvFile(fileName)) {
    parseEnv(source).forEach((entry, index) => {
      addReference(references, entry.key, file, index + 1);
    });
    return [...references.values()];
  }

  const useShellPatterns = isShellFile(fileName) || isDockerfile(fileName);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    for (const pattern of CODE_PATTERNS) {
      for (const match of line.matchAll(pattern)) {
        const name = match[1];
        if (name !== undefined) addReference(references, name, file, lineNumber);
      }
    }

    if (useShellPatterns) {
      for (const pattern of SHELL_PATTERNS) {
        for (const match of line.matchAll(pattern)) {
          const name = match[1];
          if (name !== undefined) addReference(references, name, file, lineNumber);
        }
      }
    }

    if (isDockerfile(fileName)) {
      const match = DOCKERFILE_PATTERN.exec(line);
      if (match?.[1] !== undefined) addReference(references, match[1], file, lineNumber);
    }
  });

  return [...references.values()];
}

async function walk(
  root: string,
  directory: string,
  options: Required<ScanOptions>,
  files: string[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (options.ignoreDirs.includes(entry.name)) continue;
      await walk(root, absolute, options, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!shouldScan(entry.name, options.extensions)) continue;
    try {
      const info = await stat(absolute);
      if (info.size > options.maxFileBytes) continue;
    } catch {
      continue;
    }
    files.push(absolute);
  }
}

/** Recursively scan a project for referenced environment variable names. */
export async function scanProject(cwd: string, options: ScanOptions = {}): Promise<EnvReference[]> {
  const resolvedOptions: Required<ScanOptions> = {
    extensions: options.extensions ?? DEFAULT_SOURCE_EXTENSIONS,
    ignoreDirs: options.ignoreDirs ?? DEFAULT_IGNORE_DIRS,
    maxFileBytes: options.maxFileBytes ?? 2 * 1024 * 1024,
  };

  const root = resolve(cwd);
  const files: string[] = [];
  await walk(root, root, resolvedOptions, files);
  files.sort();

  const references: EnvReference[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const relativePath = relative(root, file) || basename(file);
    references.push(...extractEnvNames(content, relativePath));
  }

  return references.sort(
    (a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file) || a.line - b.line,
  );
}

export const ENV_EXAMPLE_FILENAMES: readonly string[] = [
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.dist",
];

/** Read variable names from the first `.env.example`-style file found. */
export async function readEnvExampleNames(cwd: string): Promise<string[]> {
  for (const name of ENV_EXAMPLE_FILENAMES) {
    try {
      const content = await readFile(join(cwd, name), "utf8");
      return parseEnv(content).map((entry) => entry.key);
    } catch {
      continue;
    }
  }
  return [];
}
