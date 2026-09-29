/**
 * Shared data model for EnvVault.
 *
 * Security invariant: only `vault.enc` may ever contain secret values.
 * Every other file in `~/.envvault` and every project-local `.envvault.json`
 * may only reference secret *names*, never values.
 */

/** Version of the on-disk vault structure. Bumped when the model changes. */
export const CURRENT_VAULT_VERSION = 1;
/** Version of the encrypted envelope format (crypto scheme). */
export const CURRENT_ENVELOPE_VERSION = 1;

export interface SecretEntry {
  value: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Reserved for public/non-secret variables (e.g. PUBLIC_API_URL).
   * In v0.1 every value is stored encrypted regardless of this flag.
   */
  secret?: boolean;
}

export interface EnvironmentSecrets {
  secrets: Record<string, SecretEntry>;
}

export interface ProjectSecrets {
  shared: Record<string, SecretEntry>;
  environments: Record<string, EnvironmentSecrets>;
}

export interface VaultData {
  version: number;
  globals: Record<string, SecretEntry>;
  projects: Record<string, ProjectSecrets>;
}

/** A project + environment pair. */
export interface VaultContext {
  project: string;
  environment: string;
}

export interface ResolvedSecrets {
  [name: string]: string;
}

export type SecretOrigin = "environment" | "project" | "global";

export interface ResolvedSecret {
  name: string;
  value: string;
  origin: SecretOrigin;
}

export interface ContextMapping {
  project: string;
  environment: string;
}

export interface ContextsFile {
  version: number;
  contexts: Record<string, ContextMapping>;
}

export interface EnvVaultConfig {
  version: number;
  createdAt: string;
}

export interface MetadataFile {
  version: number;
  createdAt: string;
  lastOpenedAt?: string;
}

/** Docker section of a project-local `.envvault.json` (never holds values). */
export interface DockerInjectionConfig {
  /** `env` = plain environment injection, `secret` = Compose secrets. */
  mode?: "env" | "secret";
  /** Allowlist of secret names each Docker service may receive. */
  services?: Record<string, string[]>;
  /** Secret names exposed to BuildKit via `--secret`. */
  buildSecrets?: string[];
}

/** Shape of `.envvault.json`, project-local and secret-free. */
export interface ProjectConfig {
  project?: string;
  environment?: string;
  docker?: DockerInjectionConfig;
}

/** A derived vault key and the salt it was derived with. */
export interface VaultKey {
  key: Buffer;
  salt: Buffer;
}

/** The authenticated-encryption envelope stored in `vault.enc`. */
export interface EncryptedEnvelope {
  version: number;
  kdf: "scrypt";
  cipher: "aes-256-gcm";
  /** Base64-encoded random salt for the KDF. */
  salt: string;
  /** Base64-encoded random nonce. */
  iv: string;
  /** Base64-encoded GCM authentication tag. */
  tag: string;
  /** Base64-encoded ciphertext. */
  ciphertext: string;
}

/** Minimal clipboard abstraction so the `copy` command is testable. */
export interface Clipboard {
  copy(text: string): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Everything a command needs from the outside world. Commands never touch
 * `process` directly; this keeps them deterministic and testable.
 */
export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  /** True when both stdin and stdout are terminals. */
  isTTY: boolean;
  /** True when stdin specifically is a terminal (safe to prompt on). */
  stdinIsTTY: boolean;
  readStdin(): Promise<string>;
  promptHidden(label: string): Promise<string>;
  confirm(label: string, defaultValue?: boolean): Promise<boolean>;
}

export interface AppContext {
  cwd: string;
  home: string;
  env: NodeJS.ProcessEnv;
  io: Io;
  clipboard: Clipboard;
}

export type SecretScope =
  | { kind: "global" }
  | { kind: "project"; project: string }
  | { kind: "environment"; project: string; environment: string };
