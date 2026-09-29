/**
 * Public programmatic API for EnvVault.
 *
 * The CLI is the primary interface; this module exposes the small, stable
 * surface a library consumer needs (resolving secrets, loading a vault and the
 * shared types). Low-level crypto internals are intentionally not exported.
 */

export { VERSION } from "./core/config";
export {
  addProject,
  createEmptyVault,
  listEnvironments,
  listProjects,
  loadVault,
  removeProject,
  saveVault,
  validateVaultData,
} from "./core/vault";
export {
  resolveSecret,
  resolveSecretDetails,
  resolveSecretNames,
  resolveSecrets,
} from "./core/resolver";
export { findContextMapping, resolveDirectoryContext } from "./core/context";
export { defaultServerConfig, readServerConfig, validateServerConfig } from "./server/config";
export { listShares, listTokens, missingShareKeys } from "./server/manage";
export { buildSharePayload, decryptShareEnvelope } from "./server/share";
export { normaliseServerUrl } from "./server/client";
export { parseEnv } from "./env/parser";
export { serializeSecrets } from "./env/serializer";
export { maskSecret } from "./security/masking";
export { EnvVaultError, ExitCode } from "./utils/errors";

export type { ExportFormat } from "./env/serializer";
export type {
  BackupInfo,
  ServerConfig,
  ServerToken,
  ShareDefinition,
  SharePayload,
  ShareSummary,
  TokenGrant,
} from "./server/types";
export type {
  AppContext,
  ContextMapping,
  DockerInjectionConfig,
  EncryptedEnvelope,
  EnvVaultConfig,
  EnvironmentSecrets,
  ProjectConfig,
  ProjectSecrets,
  ResolvedSecret,
  ResolvedSecrets,
  SecretEntry,
  SecretOrigin,
  SecretScope,
  VaultContext,
  VaultData,
  VaultKey,
} from "./core/types";
