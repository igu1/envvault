/**
 * Central error taxonomy and CLI exit codes.
 *
 * Every user-facing failure should be an `EnvVaultError` subclass so the CLI
 * can print a readable message and a meaningful exit code instead of a stack
 * trace.
 */

export const ExitCode = {
  Success: 0,
  Error: 1,
  Usage: 2,
  Missing: 3,
  Auth: 4,
  Docker: 5,
  Network: 6,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export interface EnvVaultErrorOptions {
  exitCode?: number;
  hint?: string;
  cause?: unknown;
}

export class EnvVaultError extends Error {
  readonly exitCode: number;
  readonly hint: string | undefined;

  constructor(message: string, options: EnvVaultErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.exitCode = options.exitCode ?? ExitCode.Error;
    this.hint = options.hint;
  }
}

/** Bad command-line usage. */
export class UsageError extends EnvVaultError {
  constructor(message: string, hint?: string) {
    super(message, { exitCode: ExitCode.Usage, ...(hint === undefined ? {} : { hint }) });
  }
}

/** A vault does not exist yet. */
export class VaultNotInitializedError extends EnvVaultError {
  constructor(message = "EnvVault is not initialized.") {
    super(message, {
      exitCode: ExitCode.Missing,
      hint: "Run:\n\n  envvault init",
    });
  }
}

/** A password is required but the environment cannot prompt for one. */
export class VaultLockedError extends EnvVaultError {
  constructor(
    message = "EnvVault could not read a master password because stdin is not a terminal.",
  ) {
    super(message, {
      exitCode: ExitCode.Auth,
      hint: [
        "For automation, provide the password non-interactively with one of:",
        "",
        "  ENVVAULT_MASTER_PASSWORD_FILE=/run/secrets/envvault",
        "  ENVVAULT_MASTER_PASSWORD=...",
        "  printf '%s' \"$PASSWORD\" | envvault unlock --ttl 30d",
        "",
        "or reuse an existing session after `envvault unlock`.",
      ].join("\n"),
    });
  }
}

/** Authentication failed while decrypting the vault. */
export class WrongPasswordError extends EnvVaultError {
  constructor(message = "Could not decrypt the vault. The master password is incorrect.") {
    super(message, { exitCode: ExitCode.Auth });
  }
}

/** General authentication problem (mismatched confirmation, aborted prompt). */
export class AuthError extends EnvVaultError {
  constructor(message: string, hint?: string) {
    super(message, { exitCode: ExitCode.Auth, ...(hint === undefined ? {} : { hint }) });
  }
}

export class ProjectNotFoundError extends EnvVaultError {
  constructor(project: string) {
    super(`Project not found: ${project}`, {
      exitCode: ExitCode.Missing,
      hint: "List projects with:\n\n  envvault project list",
    });
  }
}

export class EnvironmentNotFoundError extends EnvVaultError {
  constructor(project: string, environment: string) {
    super(`Environment not found: ${project}/${environment}`, {
      exitCode: ExitCode.Missing,
      hint: `Create it with:\n\n  envvault project add ${project} --env ${environment}`,
    });
  }
}

export class SecretNotFoundError extends EnvVaultError {
  constructor(name: string, scopeLabel: string) {
    super(`Secret not found: ${name} in ${scopeLabel}`, { exitCode: ExitCode.Missing });
  }
}

export class ContextNotFoundError extends EnvVaultError {
  constructor(directory: string) {
    super(`No EnvVault context is associated with ${directory}`, {
      exitCode: ExitCode.Missing,
      hint: "Bind this directory with:\n\n  envvault use <project>/<environment>",
    });
  }
}

export class DockerNotFoundError extends EnvVaultError {
  constructor() {
    super("The Docker CLI was not found on PATH.", {
      exitCode: ExitCode.Docker,
      hint: "Install Docker or make sure `docker` is available in your shell.",
    });
  }
}

/** Project-local configuration is missing or malformed. */
export class ConfigError extends EnvVaultError {
  constructor(message: string, hint?: string) {
    super(message, { exitCode: ExitCode.Error, ...(hint === undefined ? {} : { hint }) });
  }
}

/** A child command could not be spawned. */
export class CommandNotFoundError extends EnvVaultError {
  constructor(command: string) {
    super(`Command not found: ${command}`, {
      exitCode: ExitCode.Error,
      hint: "Make sure the command is installed and available on PATH.",
    });
  }
}

/** The sharing server is disabled in settings. */
export class ServerDisabledError extends EnvVaultError {
  constructor() {
    super("The EnvVault sharing server is disabled.", {
      exitCode: ExitCode.Error,
      hint: [
        "Enable it first, then start it:",
        "",
        "  envvault server enable",
        "  envvault serve",
        "",
        "or turn it on under `envvault ui` → Sharing & server.",
      ].join("\n"),
    });
  }
}

/** A requested share does not exist in the server configuration. */
export class ShareNotFoundError extends EnvVaultError {
  constructor(reference: string) {
    super(`Share not found: ${reference}`, {
      exitCode: ExitCode.Missing,
      hint: "List shares with:\n\n  envvault share list",
    });
  }
}

/** A share id, backup id or token reference is malformed. */
export class ServerConfigError extends EnvVaultError {
  constructor(message: string, hint?: string) {
    super(message, { exitCode: ExitCode.Error, ...(hint === undefined ? {} : { hint }) });
  }
}

/** A share token is invalid or not accepted by the server. */
export class ShareAuthError extends EnvVaultError {
  constructor(message = "The server rejected the share token.", hint?: string) {
    super(message, {
      exitCode: ExitCode.Auth,
      ...(hint === undefined
        ? { hint: "Check the token, or ask the vault owner to issue a new one with `envvault share token create`." }
        : { hint }),
    });
  }
}

/** A remote server could not be reached or returned an unexpected response. */
export class NetworkError extends EnvVaultError {
  constructor(message: string, hint?: string) {
    super(message, { exitCode: ExitCode.Network, ...(hint === undefined ? {} : { hint }) });
  }
}

/** The serving process could not start (for example the port is in use). */
export class ServerStartError extends EnvVaultError {
  constructor(message: string, hint?: string) {
    super(message, { exitCode: ExitCode.Error, ...(hint === undefined ? {} : { hint }) });
  }
}
