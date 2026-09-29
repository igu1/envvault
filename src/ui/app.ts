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

import { intro, log, note, outro } from "@clack/prompts";

import { resolveDirectoryContext, setDirectoryContext } from "../core/context";
import { getScopedSecretEntry, listScopeSecretNames, resolveSecretNames } from "../core/resolver";
import { clearSession } from "../core/session";
import { openVault, unlockWithPasswordValue } from "../core/unlock";
import type { UnlockedVault } from "../core/unlock";
import {
  deleteSecret,
  listEnvironments,
  listProjects,
  saveVaultWithKey,
  scopeLabel,
  setSecret,
} from "../core/vault";
import { fetchHealth } from "../server/client";
import { readServerConfig } from "../server/config";
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
import { isLoopback, isWildcard, localNetworkAddresses } from "../server/net";
import { shareRef } from "../server/types";
import { maskSecret } from "../security/masking";
import type { AppContext, SecretScope, VaultData, VaultKey } from "../core/types";
import type { ServerConfig, TokenGrant } from "../server/types";
import { isValidEnvKey } from "../env/parser";
import { writeFileAtomic } from "../utils/fs";
import {
  EnvVaultError,
  ExitCode,
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

  const key = unlocked.key;
  const vault = unlocked.vault;

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
