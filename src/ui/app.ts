/**
 * `envvault ui` — an interactive terminal UI.
 *
 * A menu-driven wrapper around the same core operations the CLI uses: browse,
 * reveal, copy, set and delete secrets, and switch the current project. It
 * never writes plaintext outside the encrypted vault (revealed values are only
 * shown on screen, and copied values go to the clipboard).
 *
 * The vault is decrypted once at startup and kept in memory for the session;
 * every mutation is re-encrypted with the same derived key.
 */

import { resolve } from "node:path";

import { intro, log, note, outro } from "@clack/prompts";

import { removeContextsForProject, removeDirectoryContext, resolveDirectoryContext, setDirectoryContext } from "../core/context";
import { getScopedSecretEntry, listScopeSecretNames, resolveSecretNames, resolveSecrets } from "../core/resolver";
import { clearSession } from "../core/session";
import { backupVaultFile, readEnvelopeFile, vaultExists, writeEnvelopeFile } from "../core/storage";
import { parseEnvelope } from "../core/crypto";
import { openVault, unlockWithPasswordValue } from "../core/unlock";
import type { UnlockedVault } from "../core/unlock";
import {
  addEnvironment,
  addProject,
  deleteSecret,
  listEnvironments,
  listProjects,
  removeProject,
  saveVaultWithKey,
  scopeLabel,
  setSecret,
} from "../core/vault";
import { decryptShareEnvelope } from "../server/share";
import {
  deleteRemoteBackup,
  downloadRemoteBackup,
  fetchHealth,
  fetchShareEnvelope,
  fetchShares,
  listRemoteBackups,
  normaliseServerUrl,
  uploadRemoteBackup,
} from "../server/client";
import { DEFAULT_BACKUP_ID, isValidBackupId } from "../server/backup";
import { readServerConfig } from "../server/config";
import {
  clearServerTokens,
  findServerTokens,
  listServerTokens,
  maskToken,
  removeServerToken,
  saveServerToken,
} from "../server/token-store";
import {
  createShareToken,
  describeGrant,
  listShares,
  listTokens,
  removeShare,
  revokeShareToken,
  setServerBinding,
  setServerEnabled,
  upsertShare,
} from "../server/manage";
import { isLoopback, isPlainHttpToRemote, isWildcard, localNetworkAddresses } from "../server/net";
import { shareRef } from "../server/types";
import { maskSecret } from "../security/masking";
import type { AppContext, SecretEntry, SecretScope, VaultData, VaultKey } from "../core/types";
import type { BackupInfo, ServerConfig, ShareSummary, TokenGrant } from "../server/types";
import { isValidEnvKey, parseEnv } from "../env/parser";
import { serializeSecrets } from "../env/serializer";
import type { ExportFormat } from "../env/serializer";
import { readTextFile, writeFileAtomic } from "../utils/fs";
import {
  EnvVaultError,
  ExitCode,
  ShareAuthError,
  UsageError,
  VaultLockedError,
  WrongPasswordError,
} from "../utils/errors";
import {
  askConfirm,
  askMultiSelect,
  askPassword,
  askSelect,
  askText,
} from "./prompts";

const MAX_PASSWORD_ATTEMPTS = 3;

export async function runUi(ctx: AppContext): Promise<number> {
  if (!ctx.io.stdinIsTTY) {
    throw new UsageError(
      "`envvault ui` needs an interactive terminal.",
      "Run it directly in your terminal, not through a pipe or in CI.",
    );
  }

  intro("EnvVault");

  const unlocked = await unlockForUi(ctx);
  if (unlocked === null) {
    outro("Cancelled.");
    return ExitCode.Success;
  }

  let key = unlocked.key;
  let vault = unlocked.vault;

  await notifySharing(ctx);

  for (;;) {
    const action = await askSelect({
      message: `EnvVault  ·  ${await contextLabel(ctx)}`,
      options: [
        { value: "browse", label: "Browse secrets" },
        { value: "set", label: "Set a secret" },
        { value: "copy", label: "Copy a secret to the clipboard" },
        { value: "delete", label: "Delete a secret" },
        { value: "switch", label: "Switch project / environment" },
        { value: "projects", label: "Projects & environments" },
        { value: "importExport", label: "Import / export secrets" },
        { value: "connect", label: "Connect to a server (pull shared keys)" },
        { value: "backups", label: "Backups & sync" },
        { value: "savedTokens", label: "Saved device tokens" },
        { value: "sharing", label: "Sharing & server" },
        { value: "lock", label: "Lock vault and exit" },
        { value: "exit", label: "Exit" },
      ],
    });

    if (action === null || action === "exit") break;

    if (action === "lock") {
      await clearSession(ctx.home);
      log.success("Vault locked.");
      break;
    }

    try {
      switch (action) {
        case "browse":
          await browse(ctx, vault);
          break;
        case "set":
          await setFlow(ctx, vault, key);
          break;
        case "copy":
          await copyFlow(ctx, vault);
          break;
        case "delete":
          await deleteFlow(ctx, vault, key);
          break;
        case "switch":
          await switchFlow(ctx, vault);
          break;
        case "projects":
          await projectsFlow(ctx, vault, key);
          break;
        case "importExport":
          await importExportFlow(ctx, vault, key);
          break;
        case "connect":
          await connectFlow(ctx, vault, key);
          break;
        case "backups": {
          const replaced = await backupsFlow(ctx);
          if (replaced) {
            // `sync pull` wrote a new vault.enc and cleared the session; the
            // in-memory copy is stale, so unlock the restored vault before
            // continuing.
            const reloaded = await unlockForUi(ctx);
            if (reloaded === null) {
              outro("Vault replaced; unlock cancelled.");
              return ExitCode.Success;
            }
            key = reloaded.key;
            vault = reloaded.vault;
            log.success("Vault reloaded.");
          }
          break;
        }
        case "savedTokens":
          await savedTokensFlow(ctx);
          break;
        case "sharing":
          await sharingFlow(ctx, vault);
          break;
        default:
          break;
      }
    } catch (error) {
      log.error(errorMessage(error));
    }
  }

  outro("Done.");
  return ExitCode.Success;
}

async function unlockForUi(ctx: AppContext): Promise<UnlockedVault | null> {
  // Prefer non-interactive sources (env var, password file, session) so the
  // password prompt is only shown when it is actually needed.
  try {
    return await openVault(ctx, { allowStdinPassword: false, allowPromptPassword: false });
  } catch (error) {
    if (!(error instanceof VaultLockedError)) throw error;
  }

  for (let attempt = 1; attempt <= MAX_PASSWORD_ATTEMPTS; attempt += 1) {
    const entered = await askPassword({ message: "Master password" });
    if (entered === null) return null;
    try {
      return await unlockWithPasswordValue(ctx, entered);
    } catch (error) {
      if (error instanceof WrongPasswordError) {
        const left = MAX_PASSWORD_ATTEMPTS - attempt;
        log.error(`Wrong master password${left > 0 ? ` (${left} attempt(s) left)` : ""}.`);
        continue;
      }
      throw error;
    }
  }

  throw new WrongPasswordError();
}

async function contextLabel(ctx: AppContext): Promise<string> {
  const current = await resolveDirectoryContext(ctx.home, ctx.cwd);
  return current === null ? "no project context" : `${current.project}/${current.environment}`;
}

interface ScopeEntry {
  name: string;
  value: string;
}

function entriesInScope(vault: VaultData, scope: SecretScope): ScopeEntry[] {
  return listScopeSecretNames(vault, scope).map((name) => ({
    name,
    value: getScopedSecretEntry(vault, scope, name)?.value ?? "",
  }));
}

async function browse(ctx: AppContext, vault: VaultData): Promise<void> {
  const scope = await pickScope(ctx, vault);
  if (scope === null) return;

  for (;;) {
    const entries = entriesInScope(vault, scope);
    if (entries.length === 0) {
      log.info(`No secrets in ${scopeLabel(scope)}.`);
      return;
    }

    const selected = await askSelect({
      message: `${scopeLabel(scope)} · ${entries.length} secret(s)`,
      options: entries.map((entry) => ({
        value: entry.name,
        label: `${entry.name}   ${maskSecret(entry.value)}`,
      })),
    });
    if (selected === null) return;

    const entry = entries.find((item) => item.name === selected);
    if (entry === undefined) return;

    const action = await askSelect({
      message: entry.name,
      options: [
        { value: "reveal", label: "Reveal value" },
        { value: "copy", label: "Copy to clipboard" },
        { value: "back", label: "Back" },
      ],
    });
    if (action === null || action === "back") continue;

    if (action === "reveal") {
      note(entry.value, `Value of ${entry.name}`);
    } else if (action === "copy") {
      await ctx.clipboard.copy(entry.value);
      log.success(`Copied ${entry.name}`);
    }
  }
}

async function setFlow(ctx: AppContext, vault: VaultData, key: VaultKey): Promise<void> {
  const entered = await askText({ message: "Secret name", placeholder: "DATABASE_URL" });
  if (entered === null) return;
  const name = entered.trim();
  if (!isValidEnvKey(name)) {
    log.error("Invalid name. Use letters, digits and underscore, starting with a letter or _.");
    return;
  }

  const value = await askPassword({ message: `Value for ${name}` });
  if (value === null) return;

  const scope = await pickScope(ctx, vault);
  if (scope === null) return;

  const { created } = setSecret(vault, scope, name, value);
  await saveVaultWithKey(ctx.home, vault, key);
  log.success(`${created ? "Stored" : "Updated"} ${name} in ${scopeLabel(scope)}`);
}

async function copyFlow(ctx: AppContext, vault: VaultData): Promise<void> {
  const scope = await pickScope(ctx, vault);
  if (scope === null) return;
  const name = await pickSecretName(vault, scope);
  if (name === null) return;

  const value = getScopedSecretEntry(vault, scope, name)?.value;
  if (value === undefined) return;

  await ctx.clipboard.copy(value);
  log.success(`Copied ${name}`);
}

async function deleteFlow(ctx: AppContext, vault: VaultData, key: VaultKey): Promise<void> {
  const scope = await pickScope(ctx, vault);
  if (scope === null) return;
  const name = await pickSecretName(vault, scope);
  if (name === null) return;

  const confirmed = await askConfirm({
    message: `Delete ${name} from ${scopeLabel(scope)}? This cannot be undone.`,
  });
  if (confirmed !== true) return;

  deleteSecret(vault, scope, name);
  await saveVaultWithKey(ctx.home, vault, key);
  log.success(`Deleted ${name} from ${scopeLabel(scope)}`);
}

async function switchFlow(ctx: AppContext, vault: VaultData): Promise<void> {
  const projects = listProjects(vault);
  if (projects.length === 0) {
    log.info("No projects yet. Create one with `envvault project add <name> --env <env>`.");
    return;
  }

  const project = await askSelect({
    message: "Project",
    options: projects.map((name) => ({ value: name, label: name })),
  });
  if (project === null) return;

  const environments = listEnvironments(vault, project);
  if (environments.length === 0) {
    log.info(`${project} has no environments.`);
    return;
  }

  const environment = await askSelect({
    message: "Environment",
    options: environments.map((name) => ({ value: name, label: `${project}/${name}` })),
  });
  if (environment === null) return;

  const directory = await setDirectoryContext(ctx.home, ctx.cwd, { project, environment });
  log.success(`Bound ${directory} to ${project}/${environment}`);
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

function valuesOf(entries: Record<string, SecretEntry>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, entry] of Object.entries(entries)) values[name] = entry.value;
  return values;
}

/**
 * Values visible in a scope, matching `envvault export`: an environment scope
 * includes globals and the project's shared secrets (with the usual precedence).
 */
function valuesForScope(vault: VaultData, scope: SecretScope): Record<string, string> {
  switch (scope.kind) {
    case "global":
      return valuesOf(vault.globals);
    case "project":
      return valuesOf(vault.projects[scope.project]?.shared ?? {});
    case "environment":
      return resolveSecrets(vault, { project: scope.project, environment: scope.environment });
  }
}

function expandHome(input: string, ctx: AppContext): string {
  if (input === "~") return ctx.env.HOME ?? input;
  if (input.startsWith("~/")) return `${ctx.env.HOME ?? "~"}${input.slice(1)}`;
  return input;
}

async function importExportFlow(ctx: AppContext, vault: VaultData, key: VaultKey): Promise<void> {
  const action = await askSelect({
    message: "Import / export",
    options: [
      { value: "import", label: "Import a .env file" },
      { value: "export", label: "Export secrets" },
      { value: "back", label: "Back" },
    ],
  });
  if (action === null || action === "back") return;
  if (action === "import") await importFlow(ctx, vault, key);
  else if (action === "export") await exportFlow(ctx, vault);
}

async function importFlow(ctx: AppContext, vault: VaultData, key: VaultKey): Promise<void> {
  const entered = await askText({
    message: "Path to a .env file",
    placeholder: ".env",
    defaultValue: ".env",
  });
  if (entered === null || entered.trim() === "") return;
  const name = entered.trim();
  const absolute = resolve(ctx.cwd, expandHome(name, ctx));

  const content = await readTextFile(absolute);
  if (content === null) {
    log.error(`File not found: ${name}`);
    return;
  }
  const entries = parseEnv(content);
  if (entries.length === 0) {
    log.info("No variables found.");
    return;
  }

  const scope = await pickScope(ctx, vault);
  if (scope === null) return;

  const overwrite = await askConfirm({
    message: `Overwrite existing secrets in ${scopeLabel(scope)}?`,
    initialValue: false,
  });
  if (overwrite === null) return;

  let imported = 0;
  let skipped = 0;
  for (const entry of entries) {
    if (!overwrite && getScopedSecretEntry(vault, scope, entry.key) !== undefined) {
      skipped += 1;
      continue;
    }
    setSecret(vault, scope, entry.key, entry.value);
    imported += 1;
  }
  await saveVaultWithKey(ctx.home, vault, key);

  log.success(`Imported ${imported} secret${imported === 1 ? "" : "s"} into ${scopeLabel(scope)}.`);
  if (skipped > 0) log.info(`${skipped} already existed and ${overwrite ? "were replaced" : "were skipped"}.`);
}

async function exportFlow(ctx: AppContext, vault: VaultData): Promise<void> {
  const scope = await pickScope(ctx, vault);
  if (scope === null) return;

  const secrets = valuesForScope(vault, scope);
  const count = Object.keys(secrets).length;
  if (count === 0) {
    log.info(`No secrets in ${scopeLabel(scope)}.`);
    return;
  }

  const format = await askSelect({
    message: "Format",
    options: [
      { value: "env", label: "dotenv  KEY=value" },
      { value: "json", label: "JSON" },
      { value: "shell", label: "Shell  export KEY=..." },
      { value: "csv", label: "CSV  name,value (import as text)" },
    ],
  });
  if (format === null) return;
  const content = serializeSecrets(secrets, format as ExportFormat);

  const destination = await askSelect({
    message: `Export ${count} secret(s) from ${scopeLabel(scope)}`,
    options: [
      { value: "screen", label: "Show on screen" },
      { value: "file", label: "Write to a file (0600)" },
      { value: "back", label: "Back" },
    ],
  });
  if (destination === null || destination === "back") return;

  if (destination === "screen") {
    note(content.replace(/\n$/, ""), `${scopeLabel(scope)} · ${format}`);
    return;
  }

  const entered = await askText({ message: "File path", placeholder: ".env" });
  if (entered === null || entered.trim() === "") return;
  const absolute = resolve(ctx.cwd, expandHome(entered.trim(), ctx));
  await writeFileAtomic(absolute, content, 0o600);
  log.warn("This creates a plaintext secret file.");
  log.success(`Wrote ${count} secret(s) to ${absolute} (mode 0600).`);
}

// ---------------------------------------------------------------------------
// Projects & environments
// ---------------------------------------------------------------------------

async function projectsFlow(ctx: AppContext, vault: VaultData, key: VaultKey): Promise<void> {
  for (;;) {
    const projects = listProjects(vault);
    const action = await askSelect({
      message: `${projects.length} project${projects.length === 1 ? "" : "s"}`,
      options: [
        { value: "add", label: "Create a project…" },
        ...projects.flatMap((name) => [
          { value: `addEnv:${name}`, label: `Add an environment to ${name}…` },
          { value: `remove:${name}`, label: `Remove ${name}…` },
        ]),
        { value: "unuse", label: "Disconnect this directory (unuse)" },
        { value: "back", label: "Back" },
      ],
    });
    if (action === null || action === "back") return;

    if (action === "add") await addProjectFlow(ctx, vault, key);
    else if (action === "unuse") await unuseFlow(ctx);
    else if (action.startsWith("addEnv:")) {
      await addEnvironmentFlow(ctx, vault, key, action.slice("addEnv:".length));
    } else if (action.startsWith("remove:")) {
      await removeProjectFlow(ctx, vault, key, action.slice("remove:".length));
    }
  }
}

function splitList(input: string): string[] {
  return input
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

async function addProjectFlow(ctx: AppContext, vault: VaultData, key: VaultKey): Promise<void> {
  const entered = await askText({ message: "Project name", placeholder: "crono" });
  if (entered === null || entered.trim() === "") return;
  const name = entered.trim();

  const envInput = await askText({
    message: "Environments (comma-separated, optional)",
    placeholder: "dev,staging",
  });
  if (envInput === null) return;

  const { created } = addProject(vault, name);
  let added = 0;
  for (const environment of splitList(envInput)) {
    if (addEnvironment(vault, name, environment)) added += 1;
  }
  await saveVaultWithKey(ctx.home, vault, key);

  log.success(created ? `Created project: ${name}` : `Project already existed: ${name}`);
  if (added > 0) log.success(`Added ${added} environment${added === 1 ? "" : "s"}.`);
}

async function addEnvironmentFlow(
  ctx: AppContext,
  vault: VaultData,
  key: VaultKey,
  project: string,
): Promise<void> {
  const entered = await askText({
    message: `Environments for ${project} (comma-separated)`,
    placeholder: "production",
  });
  if (entered === null || entered.trim() === "") return;

  let added = 0;
  let existing = 0;
  for (const environment of splitList(entered)) {
    if (addEnvironment(vault, project, environment)) added += 1;
    else existing += 1;
  }
  if (added > 0) await saveVaultWithKey(ctx.home, vault, key);

  if (added > 0) log.success(`Added ${added} environment${added === 1 ? "" : "s"} to ${project}.`);
  if (existing > 0) log.info(`${existing} already existed.`);
}

async function removeProjectFlow(
  ctx: AppContext,
  vault: VaultData,
  key: VaultKey,
  project: string,
): Promise<void> {
  const confirmed = await askConfirm({
    message: `Remove ${project} and all of its secrets? This cannot be undone.`,
    initialValue: false,
  });
  if (confirmed !== true) return;

  removeProject(vault, project);
  await saveVaultWithKey(ctx.home, vault, key);
  const cleared = await removeContextsForProject(ctx.home, project);

  log.success(`Removed project: ${project}`);
  if (cleared.length > 0) {
    log.info(`Cleared ${cleared.length} directory mapping${cleared.length === 1 ? "" : "s"}.`);
  }
}

async function unuseFlow(ctx: AppContext): Promise<void> {
  if (await removeDirectoryContext(ctx.home, ctx.cwd)) {
    log.success(`Disconnected ${ctx.cwd}`);
    return;
  }

  const current = await resolveDirectoryContext(ctx.home, ctx.cwd);
  if (current === null) {
    log.info("This directory is not connected to a project.");
    return;
  }
  if (current.source === "project-config") {
    log.warn(`${ctx.cwd} is bound by .envvault.json; remove its "project"/"environment" fields.`);
    return;
  }
  log.warn(`No mapping is stored for ${ctx.cwd}.`);
  log.info(`It inherits ${current.project}/${current.environment} from ${current.directory}.`);
}

// ---------------------------------------------------------------------------
// Connect (pull shared keys) and backups
// ---------------------------------------------------------------------------

/** Ask for a server URL, offering any already saved in the device token store. */
async function askServerUrl(ctx: AppContext, message: string): Promise<string | null> {
  const saved = await listServerTokens(ctx.home);
  const urls = [...new Set(saved.map((entry) => entry.url))].sort();

  if (urls.length > 0) {
    const choice = await askSelect({
      message,
      options: [
        ...urls.map((url) => ({ value: url, label: url })),
        { value: "__new__", label: "Enter a new URL…" },
      ],
    });
    if (choice === null) return null;
    if (choice !== "__new__") return choice;
  }

  const entered = await askText({ message, placeholder: "http://192.168.1.10:8787" });
  if (entered === null || entered.trim() === "") return null;
  return normaliseServerUrl(entered.trim());
}

/** Reuse a saved token for `baseUrl`, or collect a new one. */
async function resolveTokenForUi(ctx: AppContext, baseUrl: string): Promise<string | null> {
  const saved = await findServerTokens(ctx.home, baseUrl);
  if (saved.length === 1) return saved[0]!.token;
  if (saved.length > 1) {
    const choice = await askSelect({
      message: `Token for ${baseUrl}`,
      options: [
        ...saved.map((entry) => ({
          value: entry.token,
          label: `${entry.label ?? "saved"}  ${maskToken(entry.token)}`,
        })),
        { value: "__new__", label: "Enter a different token…" },
      ],
    });
    if (choice === null) return null;
    if (choice !== "__new__") return choice;
  }

  const entered = await askPassword({ message: `Share token for ${baseUrl}` });
  if (entered === null || entered.trim() === "") return null;
  return entered.trim();
}

/** Save a token the server has already accepted, matching the CLI behaviour. */
async function rememberTokenForUi(ctx: AppContext, baseUrl: string, token: string): Promise<void> {
  const { created } = await saveServerToken(ctx.home, { url: baseUrl, token });
  if (created) {
    log.info(`Token saved for ${baseUrl}. Forget it under "Saved device tokens".`);
  }
}

function warnPlainHttp(baseUrl: string): void {
  if (!isPlainHttpToRemote(baseUrl)) return;
  log.warn(`Sending your share token unencrypted to ${baseUrl}. Anyone on the network path can read it.`);
  log.warn(`If the server supports TLS, use ${baseUrl.replace(/^http:/, "https:")}.`);
}

async function connectFlow(ctx: AppContext, vault: VaultData, key: VaultKey): Promise<void> {
  const baseUrl = await askServerUrl(ctx, "Server URL");
  if (baseUrl === null) return;
  warnPlainHttp(baseUrl);

  const token = await resolveTokenForUi(ctx, baseUrl);
  if (token === null) return;

  try {
    await fetchHealth(baseUrl);
  } catch (error) {
    log.error(errorMessage(error));
    return;
  }

  let shares: ShareSummary[];
  try {
    shares = await fetchShares(baseUrl, token);
  } catch (error) {
    log.error(errorMessage(error));
    if (error instanceof ShareAuthError) {
      log.info("The token may be stale; forget it under \"Saved device tokens\".");
    }
    return;
  }
  await rememberTokenForUi(ctx, baseUrl, token);

  if (shares.length === 0) {
    log.info("Nothing is shared with this token.");
    return;
  }

  let chosen: ShareSummary | undefined;
  if (shares.length === 1) {
    chosen = shares[0];
  } else {
    const pick = await askSelect({
      message: "Share",
      options: shares.map((share) => ({
        value: shareRef(share.project, share.environment),
        label: `${shareRef(share.project, share.environment)}  (${share.keys.length} key(s))`,
      })),
    });
    if (pick === null) return;
    chosen = shares.find((share) => shareRef(share.project, share.environment) === pick);
  }
  if (chosen === undefined) return;

  let payload;
  try {
    const envelope = await fetchShareEnvelope(baseUrl, token, chosen.project, chosen.environment);
    payload = await decryptShareEnvelope(envelope, token);
  } catch (error) {
    log.error(errorMessage(error));
    return;
  }

  const entries = Object.entries(payload.secrets);
  note(
    entries.length === 0
      ? "(no values in this share)"
      : entries.map(([name, value]) => `${name}  ${maskSecret(value)}`).join("\n"),
    `Share ${shareRef(payload.project, payload.environment)} · ${baseUrl}`,
  );
  if (entries.length === 0) return;

  const confirmed = await askConfirm({
    message: `Store ${entries.length} key(s) in this vault?`,
    initialValue: true,
  });
  if (confirmed !== true) return;

  const scope = await pickScope(ctx, vault);
  if (scope === null) return;

  for (const [name, value] of entries) setSecret(vault, scope, name, value);
  await saveVaultWithKey(ctx.home, vault, key);
  log.success(`Stored ${entries.length} key(s) in ${scopeLabel(scope)}.`);
  if (payload.missing.length > 0) log.warn(`missing on the server: ${payload.missing.join(", ")}`);
}

function formatBackupList(backups: BackupInfo[]): string {
  if (backups.length === 0) return "No backups yet.";
  return backups
    .map((backup) => `${backup.id}  ${backup.size} bytes  ${backup.uploadedAt}  sha256:${backup.sha256.slice(0, 12)}`)
    .join("\n");
}

async function askBackupId(ctx: AppContext, defaultValue: string): Promise<string | null> {
  const entered = await askText({
    message: "Backup id",
    placeholder: defaultValue,
    defaultValue,
  });
  if (entered === null || entered.trim() === "") return null;
  const id = entered.trim();
  if (!isValidBackupId(id)) {
    log.error("Invalid backup id. Use letters, digits, dot, dash and underscore (max 64 characters).");
    return null;
  }
  return id;
}

async function pickBackupId(backups: BackupInfo[]): Promise<string | null> {
  if (backups.length === 1) return backups[0]!.id;
  return await askSelect({
    message: "Backup",
    options: backups.map((backup) => ({
      value: backup.id,
      label: `${backup.id}  ${backup.size} bytes  ${backup.uploadedAt}`,
    })),
  });
}

/** Returns true when the local vault was replaced and must be reloaded. */
async function backupsFlow(ctx: AppContext): Promise<boolean> {
  const baseUrl = await askServerUrl(ctx, "Server URL");
  if (baseUrl === null) return false;
  warnPlainHttp(baseUrl);

  const token = await resolveTokenForUi(ctx, baseUrl);
  if (token === null) return false;

  let backups: BackupInfo[];
  try {
    backups = await listRemoteBackups(baseUrl, token);
  } catch (error) {
    log.error(errorMessage(error));
    if (error instanceof ShareAuthError) {
      log.info("This token may be missing the backup grant; create one with `--backup`.");
    }
    return false;
  }
  await rememberTokenForUi(ctx, baseUrl, token);

  for (;;) {
    const action = await askSelect({
      message: `Backups on ${baseUrl} · ${backups.length}`,
      options: [
        { value: "list", label: "List backups" },
        { value: "push", label: "Push this vault" },
        { value: "pull", label: "Pull a backup (replaces this vault)" },
        ...(backups.length > 0 ? [{ value: "remove", label: "Remove a backup" }] : []),
        { value: "back", label: "Back" },
      ],
    });
    if (action === null || action === "back") return false;

    if (action === "list") {
      note(formatBackupList(backups), `Backups on ${baseUrl}`);
      continue;
    }
    if (action === "push") {
      if (await pushBackupFlow(ctx, baseUrl, token, backups)) {
        backups = await listRemoteBackups(baseUrl, token);
      }
      continue;
    }
    if (action === "pull") {
      if (await pullBackupFlow(ctx, baseUrl, token, backups)) return true;
      continue;
    }
    if (action === "remove") {
      if (await removeBackupFlow(ctx, baseUrl, token, backups)) {
        backups = await listRemoteBackups(baseUrl, token);
      }
      continue;
    }
  }
}

async function pushBackupFlow(
  ctx: AppContext,
  baseUrl: string,
  token: string,
  backups: BackupInfo[],
): Promise<boolean> {
  if (!(await vaultExists(ctx.home))) {
    log.error("There is no vault to push.");
    return false;
  }
  const id = await askBackupId(ctx, DEFAULT_BACKUP_ID);
  if (id === null) return false;

  if (backups.some((backup) => backup.id === id)) {
    const confirmed = await askConfirm({
      message: `Overwrite backup "${id}" on ${baseUrl}?`,
      initialValue: false,
    });
    if (confirmed !== true) return false;
  }

  const envelope = await readEnvelopeFile(ctx.home);
  const info = await uploadRemoteBackup(baseUrl, token, id, envelope);
  log.success(`Pushed to ${baseUrl} as "${info.id}" (${info.size} bytes, encrypted).`);
  return true;
}

async function pullBackupFlow(
  ctx: AppContext,
  baseUrl: string,
  token: string,
  backups: BackupInfo[],
): Promise<boolean> {
  if (backups.length === 0) {
    log.info("No backups to pull.");
    return false;
  }
  const id = await pickBackupId(backups);
  if (id === null) return false;

  const downloaded = await downloadRemoteBackup(baseUrl, token, id);
  parseEnvelope(downloaded.envelope);

  const confirmed = await askConfirm({
    message: `Replace this vault with "${downloaded.info.id}"? The current vault.enc is kept as a .bak file.`,
    initialValue: false,
  });
  if (confirmed !== true) return false;

  const backupPath = await backupVaultFile(ctx.home);
  await writeEnvelopeFile(ctx.home, downloaded.envelope);
  await clearSession(ctx.home);

  log.success("Local vault replaced.");
  if (backupPath !== null) log.info(`Previous vault saved to ${backupPath}`);
  log.info("The next command may ask for the master password of the restored vault.");
  return true;
}

async function removeBackupFlow(
  ctx: AppContext,
  baseUrl: string,
  token: string,
  backups: BackupInfo[],
): Promise<boolean> {
  if (backups.length === 0) {
    log.info("No backups to remove.");
    return false;
  }
  const id = await pickBackupId(backups);
  if (id === null) return false;

  const confirmed = await askConfirm({
    message: `Delete backup "${id}" on ${baseUrl}?`,
    initialValue: false,
  });
  if (confirmed !== true) return false;

  await deleteRemoteBackup(baseUrl, token, id);
  log.success(`Deleted backup "${id}" on ${baseUrl}.`);
  return true;
}

// ---------------------------------------------------------------------------
// Saved device tokens
// ---------------------------------------------------------------------------

async function savedTokensFlow(ctx: AppContext): Promise<void> {
  for (;;) {
    const tokens = await listServerTokens(ctx.home);
    if (tokens.length === 0) {
      log.info("No share tokens saved on this device.");
      return;
    }

    const action = await askSelect({
      message: `${tokens.length} saved token${tokens.length === 1 ? "" : "s"}`,
      options: [
        ...tokens.map((entry, index) => ({
          value: `remove:${index}`,
          label: `${entry.url}  ${maskToken(entry.token)}${entry.label === undefined ? "" : `  (${entry.label})`}`,
        })),
        { value: "clear", label: "Forget all saved tokens" },
        { value: "back", label: "Back" },
      ],
    });
    if (action === null || action === "back") return;

    if (action === "clear") {
      const confirmed = await askConfirm({ message: "Forget every saved token on this device?" });
      if (confirmed !== true) continue;
      const removed = await clearServerTokens(ctx.home);
      log.success(`Removed ${removed} saved token${removed === 1 ? "" : "s"}.`);
      continue;
    }

    const entry = tokens[Number(action.slice("remove:".length))];
    if (entry === undefined) continue;
    const confirmed = await askConfirm({ message: `Forget the token for ${entry.url}?` });
    if (confirmed !== true) continue;
    const removed = await removeServerToken(ctx.home, entry.url, entry.token);
    log.success(`Removed ${removed} saved token${removed === 1 ? "" : "s"}.`);
  }
}

async function pickSecretName(vault: VaultData, scope: SecretScope): Promise<string | null> {
  const names = listScopeSecretNames(vault, scope);
  if (names.length === 0) {
    log.info(`No secrets in ${scopeLabel(scope)}.`);
    return null;
  }
  return await askSelect({
    message: `Secret in ${scopeLabel(scope)}`,
    options: names.map((name) => ({ value: name, label: name })),
  });
}

/** Choose global, the current environment, or any project/environment. */
async function pickScope(ctx: AppContext, vault: VaultData): Promise<SecretScope | null> {
  const current = await resolveDirectoryContext(ctx.home, ctx.cwd);

  const options: Array<{ value: string; label: string }> = [];
  if (current !== null) {
    options.push({
      value: `here:${current.project}/${current.environment}`,
      label: `${current.project}/${current.environment} (current)`,
    });
  }
  options.push({ value: "global", label: "Global secrets" });
  options.push({ value: "other", label: "Another project…" });

  const choice = await askSelect({ message: "Where?", options });
  if (choice === null) return null;

  if (choice === "global") return { kind: "global" };

  if (choice.startsWith("here:")) {
    const [project, environment] = choice.slice("here:".length).split("/");
    if (project === undefined || environment === undefined) return null;
    return { kind: "environment", project, environment };
  }

  const projects = listProjects(vault);
  if (projects.length === 0) {
    log.info("No projects yet.");
    return null;
  }

  const project = await askSelect({
    message: "Project",
    options: projects.map((name) => ({ value: name, label: name })),
  });
  if (project === null) return null;

  const envChoice = await askSelect({
    message: "Scope",
    options: [
      { value: "__shared__", label: `${project} (project shared)` },
      ...listEnvironments(vault, project).map((name) => ({
        value: `env:${name}`,
        label: `${project}/${name}`,
      })),
    ],
  });
  if (envChoice === null) return null;

  if (envChoice === "__shared__") return { kind: "project", project };
  return { kind: "environment", project, environment: envChoice.slice("env:".length) };
}

function errorMessage(error: unknown): string {
  if (error instanceof EnvVaultError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Sharing & server
// ---------------------------------------------------------------------------

/** A one-line, human-readable summary of the sharing configuration. */
function sharingSummary(config: ServerConfig, running: boolean): string {
  if (!config.enabled) return "Sharing is off";
  const state = running ? "running" : "not running";
  return `Sharing is on (${state}) · ${config.host}:${config.port} · ${config.shares.length} share(s) · ${config.tokens.length} token(s)`;
}

async function probeSharing(config: ServerConfig): Promise<boolean> {
  const host = isWildcard(config.host) ? "127.0.0.1" : config.host;
  try {
    await fetchHealth(`http://${host}:${config.port}`, 500);
    return true;
  } catch {
    return false;
  }
}

/** Startup notification: surface the sharing state without being noisy. */
async function notifySharing(ctx: AppContext): Promise<void> {
  const config = await readServerConfig(ctx.home);
  if (!config.enabled) return;
  const running = await probeSharing(config);
  const lines = [
    sharingSummary(config, running),
    running ? "" : "Start it with `envvault serve`.",
    isLoopback(config.host) ? "Reachable from this machine only." : `Exposed on ${config.host}.`,
  ].filter((line) => line !== "");
  note(lines.join("\n"), "Server");
}

async function sharingFlow(ctx: AppContext, vault: VaultData): Promise<void> {
  for (;;) {
    const config = await readServerConfig(ctx.home);
    const running = config.enabled ? await probeSharing(config) : false;

    const action = await askSelect({
      message: sharingSummary(config, running),
      options: [
        { value: "status", label: "Show server details" },
        {
          value: "toggle",
          label: config.enabled ? "Disable sharing" : "Enable sharing",
        },
        { value: "host", label: `Set bind address (${config.host})` },
        { value: "port", label: `Set port (${config.port})` },
        { value: "shares", label: `Manage shared keys (${config.shares.length})` },
        { value: "tokens", label: `Manage tokens (${config.tokens.length})` },
        { value: "back", label: "Back" },
      ],
    });
    if (action === null || action === "back") return;

    switch (action) {
      case "status":
        await showSharingStatus(ctx, config, running);
        break;
      case "toggle":
        await toggleSharing(ctx, config.enabled);
        break;
      case "host":
        await setHostFlow(ctx, config.host);
        break;
      case "port":
        await setPortFlow(ctx, config.port);
        break;
      case "shares":
        await manageSharesFlow(ctx, vault);
        break;
      case "tokens":
        await manageTokensFlow(ctx);
        break;
      default:
        break;
    }
  }
}

async function showSharingStatus(
  ctx: AppContext,
  config: ServerConfig,
  running: boolean,
): Promise<void> {
  const tokens = await listTokens(ctx.home);
  const lines = [
    `Enabled:      ${config.enabled ? "yes" : "no"}`,
    `Running:      ${config.enabled ? (running ? "yes" : "no") : "-"}`,
    `Address:      ${config.host}:${config.port}`,
    `Shares:       ${config.shares.length}`,
    `Tokens:       ${config.tokens.length}`,
  ];
  if (!isLoopback(config.host)) {
    lines.push("", `Warning: ${config.host} is reachable from other machines.`);
    const addresses = localNetworkAddresses();
    if (addresses.length > 0) lines.push(`Local addresses: ${addresses.join(", ")}`);
  }
  if (tokens.length > 0) {
    lines.push("", "Grants:");
    for (const token of tokens) lines.push(`  ${token.label}: ${describeGrant(token.grant)}`);
  }
  note(lines.join("\n"), "Server");
}

async function toggleSharing(ctx: AppContext, currentlyEnabled: boolean): Promise<void> {
  const config = await setServerEnabled(ctx.home, !currentlyEnabled);
  if (config.enabled) {
    log.success("Sharing enabled. Start the server with `envvault serve`.");
    if (!isLoopback(config.host)) {
      log.warn(`Bound to ${config.host}: reachable from other machines.`);
    }
  } else {
    log.success("Sharing disabled. A running server keeps serving until you stop it.");
  }
}

async function setHostFlow(ctx: AppContext, current: string): Promise<void> {
  const entered = await askText({
    message: "Bind address",
    placeholder: current,
    defaultValue: current,
  });
  if (entered === null || entered.trim() === "") return;
  const config = await setServerBinding(ctx.home, { host: entered.trim() });
  log.success(`Bind address set to ${config.host}`);
  if (!isLoopback(config.host)) {
    log.warn(`${config.host} exposes the server to your network.`);
  }
}

async function setPortFlow(ctx: AppContext, current: number): Promise<void> {
  const entered = await askText({
    message: "Port",
    placeholder: String(current),
    defaultValue: String(current),
  });
  if (entered === null) return;
  const port = Number(entered);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    log.error("Use a number between 0 and 65535.");
    return;
  }
  const config = await setServerBinding(ctx.home, { port });
  log.success(`Port set to ${config.port}`);
}

async function manageSharesFlow(ctx: AppContext, vault: VaultData): Promise<void> {
  const shares = await listShares(ctx.home);
  const action = await askSelect({
    message: `${shares.length} shared environment(s)`,
    options: [
      { value: "add", label: "Share an environment…" },
      ...shares.map((share) => ({
        value: `remove:${shareRef(share.project, share.environment)}`,
        label: `Stop sharing ${shareRef(share.project, share.environment)} (${share.keys.length} key(s))`,
      })),
      { value: "back", label: "Back" },
    ],
  });
  if (action === null || action === "back") return;

  if (action === "add") {
    await addShareFlow(ctx, vault);
    return;
  }
  const reference = action.slice("remove:".length);
  const [project, environment] = reference.split("/");
  if (project === undefined || environment === undefined) return;
  const confirmed = await askConfirm({
    message: `Stop sharing ${reference}? Holders of existing tokens will lose access.`,
  });
  if (confirmed !== true) return;
  await removeShare(ctx.home, project, environment);
  log.success(`Stopped sharing ${reference}`);
}

async function addShareFlow(ctx: AppContext, vault: VaultData): Promise<void> {
  const projects = listProjects(vault);
  if (projects.length === 0) {
    log.info("No projects yet. Create one with `envvault project add <name> --env <env>`.");
    return;
  }
  const project = await askSelect({
    message: "Project",
    options: projects.map((name) => ({ value: name, label: name })),
  });
  if (project === null) return;

  const environments = listEnvironments(vault, project);
  if (environments.length === 0) {
    log.info(`${project} has no environments.`);
    return;
  }
  const environment = await askSelect({
    message: "Environment",
    options: environments.map((name) => ({ value: name, label: `${project}/${name}` })),
  });
  if (environment === null) return;

  const available = resolveSecretNames(vault, { project, environment });
  if (available.length === 0) {
    log.info(`No keys in ${project}/${environment}.`);
    return;
  }

  const keys = await askMultiSelect({
    message: `Keys to share from ${project}/${environment}`,
    options: available.map((name) => ({ value: name, label: name })),
    initialValues: available,
    required: true,
  });
  if (keys === null || keys.length === 0) return;

  const label = await askText({
    message: "Label (optional)",
    placeholder: `${project}/${environment}`,
  });

  const { created } = await upsertShare(ctx.home, {
    project,
    environment,
    keys,
    ...(label !== null && label.trim() !== "" ? { label: label.trim() } : {}),
  });
  log.success(
    `${created ? "Sharing" : "Updated"} ${project}/${environment} (${keys.length} key(s))`,
  );
  if (!created) log.info("Tokens already granted access to this share see the new key list.");
}

async function manageTokensFlow(ctx: AppContext): Promise<void> {
  const tokens = await listTokens(ctx.home);
  const action = await askSelect({
    message: `${tokens.length} token(s)`,
    options: [
      { value: "create", label: "Create a token…" },
      ...tokens.map((token) => ({
        value: `revoke:${token.id}`,
        label: `Revoke ${token.label} (${describeGrant(token.grant)})`,
      })),
      { value: "back", label: "Back" },
    ],
  });
  if (action === null || action === "back") return;

  if (action === "create") {
    await createTokenFlow(ctx);
    return;
  }
  const id = action.slice("revoke:".length);
  const confirmed = await askConfirm({
    message: "Revoke this token? Whoever holds it will be locked out immediately.",
  });
  if (confirmed !== true) return;
  await revokeShareToken(ctx.home, id);
  log.success(`Revoked token ${id}`);
}

async function createTokenFlow(ctx: AppContext): Promise<void> {
  const label = await askText({ message: "Token label", placeholder: "laptop" });
  if (label === null || label.trim() === "") return;

  const shares = await listShares(ctx.home);
  let grantShares: TokenGrant["shares"] = "all";
  if (shares.length > 1) {
    const scope = await askSelect({
      message: "Which shares may this token read?",
      options: [
        { value: "all", label: "All current and future shares" },
        { value: "pick", label: "Choose specific shares…" },
      ],
    });
    if (scope === null) return;
    if (scope === "pick") {
      const chosen = await askMultiSelect({
        message: "Shares",
        options: shares.map((share) => ({
          value: shareRef(share.project, share.environment),
          label: shareRef(share.project, share.environment),
        })),
        required: true,
      });
      if (chosen === null || chosen.length === 0) return;
      grantShares = chosen;
    }
  }

  const backup = await askConfirm({
    message: "Allow encrypted vault backups with this token?",
    initialValue: false,
  });
  if (backup === null) return;

  const { token, record } = await createShareToken(ctx.home, label.trim(), {
    shares: grantShares,
    backup,
  });

  log.success(`Created token ${record.id} (${describeGrant(record.grant)})`);
  await storeTokenFlow(ctx, token);
}

/** The "where to store it" step: clipboard, a 0600 file, or on screen. */
async function storeTokenFlow(ctx: AppContext, token: string): Promise<void> {
  const choice = await askSelect({
    message: "Where should the token be stored? It is shown only once.",
    options: [
      { value: "clipboard", label: "Copy to clipboard (recommended)" },
      { value: "file", label: "Write to a file…" },
      { value: "screen", label: "Show it on screen" },
    ],
  });
  if (choice === null || choice === "screen") {
    note(token, "Share token (shown once)");
    return;
  }

  if (choice === "clipboard") {
    await ctx.clipboard.copy(token);
    log.success("Token copied to the clipboard.");
    return;
  }

  const path = await askText({
    message: "File path",
    placeholder: "~/crono-share-token",
  });
  if (path === null || path.trim() === "") {
    note(token, "Share token (shown once)");
    return;
  }
  const expanded = path.trim().replace(/^~(?=\/|$)/, ctx.env.HOME ?? "~");
  try {
    await writeFileAtomic(expanded, `${token}\n`, 0o600);
    log.success(`Token stored in ${expanded} (mode 0600).`);
  } catch (error) {
    log.error(`Could not write the token: ${errorMessage(error)}`);
    note(token, "Share token (shown once)");
  }
}
