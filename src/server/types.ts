/**
 * Data model for the opt-in sharing server.
 *
 * Security invariant: `~/.envvault/server.json` contains secret *names* and
 * token *derivatives* only. It never contains a secret value and never contains
 * a raw share token — the token is shown to the user once, then only its
 * scrypt-derived key and salt are kept (the same trade-off as `session.json`).
 */

/** Version of the on-disk server configuration. */
export const CURRENT_SERVER_VERSION = 1;

/** Bind to loopback unless the user explicitly opts into the network. */
export const DEFAULT_SERVER_HOST = "127.0.0.1";
export const DEFAULT_SERVER_PORT = 8787;

/** Prefix that makes a leaked token recognisable in logs and scanners. */
export const SERVER_TOKEN_PREFIX = "evt_";

/** Capabilities granted to a share token. */
export interface TokenGrant {
  /** `"all"` or a list of `project/environment` references. */
  shares: "all" | string[];
  /** Whether the token may push/pull encrypted vault backups. */
  backup: boolean;
}

/** A set of environment keys exposed to holders of a token. */
export interface ShareDefinition {
  project: string;
  environment: string;
  label?: string;
  /** Allowlist of secret names. Values are read live from the vault. */
  keys: string[];
  createdAt: string;
  updatedAt: string;
}

/** A token record. The raw token is never persisted. */
export interface ServerToken {
  id: string;
  label: string;
  /** Base64 scrypt-derived key. */
  key: string;
  /** Base64 salt used to derive `key`. */
  salt: string;
  grant: TokenGrant;
  createdAt: string;
}

export interface ServerConfig {
  version: number;
  enabled: boolean;
  host: string;
  port: number;
  shares: ShareDefinition[];
  tokens: ServerToken[];
}

/** What `GET /shares` returns per share: names only, never values. */
export interface ShareSummary {
  project: string;
  environment: string;
  label?: string;
  keys: string[];
  updatedAt: string;
}

/** The plaintext that is encrypted into a share payload. */
export interface SharePayload {
  project: string;
  environment: string;
  label?: string;
  exportedAt: string;
  secrets: Record<string, string>;
  /** Allowlisted names that no longer exist in the vault. */
  missing: string[];
}

/** Metadata for an uploaded encrypted vault backup. */
export interface BackupInfo {
  id: string;
  uploadedAt: string;
  size: number;
  sha256: string;
}

/** Stable identity for a share: one share per project/environment pair. */
export function shareRef(project: string, environment: string): string {
  return `${project}/${environment}`;
}

/** Parse a `project/environment` reference. Returns null when malformed. */
export function parseShareRef(reference: string): { project: string; environment: string } | null {
  const parts = reference.split("/");
  if (parts.length !== 2) return null;
  const [project, environment] = parts;
  if (project === undefined || environment === undefined) return null;
  if (project === "" || environment === "") return null;
  return { project, environment };
}
