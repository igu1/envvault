/**
 * Share tokens saved on this device.
 *
 * A token is the credential a *client* needs to read a share, so re-typing it
 * on every `connect`/`sync` is pure friction. This store keeps them in
 * `~/.envvault/share-tokens.json` (mode 0600, inside the 0700 home) keyed by
 * server URL, so a given server is only asked for its token once.
 *
 * Trade-off, stated plainly: a saved token is a bearer credential for whatever
 * shares it grants. Anyone who can read the file as your user can use it — the
 * same access level already required to read `session.json` or `vault.enc`. Use
 * `--no-save`, `ENVVAULT_NO_TOKEN_STORE=1`, or `envvault tokens remove <url>`
 * if that is not acceptable.
 *
 * The token is stored verbatim because it must be replayed on each request;
 * unlike `server.json` (owner side) there is no derived form we could use.
 */

import { nowIso } from "../core/config";
import { vaultPaths } from "../core/storage";
import { ConfigError } from "../utils/errors";
import { readJsonFile, writeJsonAtomic } from "../utils/fs";

export const CURRENT_TOKEN_STORE_VERSION = 1;

export interface StoredToken {
  /** Normalised server URL this token belongs to. */
  url: string;
  token: string;
  /** Optional human label. */
  label?: string;
  savedAt: string;
  lastUsedAt: string;
}

export interface TokenStore {
  version: number;
  tokens: StoredToken[];
}

export function tokenStorePath(home: string): string {
  return vaultPaths(home).tokens;
}

export function emptyTokenStore(): TokenStore {
  return { version: CURRENT_TOKEN_STORE_VERSION, tokens: [] };
}

/** Show enough of a token to tell two apart, never enough to use it. */
export function maskToken(token: string): string {
  if (token.length <= 12) return `${token.slice(0, 4)}…`;
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateEntry(raw: unknown, source: string): StoredToken {
  if (!isObject(raw)) throw new ConfigError(`${source} is not an object.`);
  if (typeof raw.url !== "string" || !/^https?:\/\//.test(raw.url)) {
    throw new ConfigError(`${source}: "url" must be an http(s) URL.`);
  }
  if (typeof raw.token !== "string" || raw.token === "") {
    throw new ConfigError(`${source}: "token" is missing.`);
  }

  const now = nowIso();
  const entry: StoredToken = {
    url: raw.url,
    token: raw.token,
    savedAt: typeof raw.savedAt === "string" ? raw.savedAt : now,
    lastUsedAt: typeof raw.lastUsedAt === "string" ? raw.lastUsedAt : now,
  };
  if (typeof raw.label === "string") entry.label = raw.label;
  return entry;
}

export function validateTokenStore(raw: unknown, source = "share-tokens.json"): TokenStore {
  if (!isObject(raw)) throw new ConfigError(`${source} must contain a JSON object.`);

  const version = typeof raw.version === "number" ? raw.version : CURRENT_TOKEN_STORE_VERSION;
  if (version > CURRENT_TOKEN_STORE_VERSION) {
    throw new ConfigError(
      `${source} was written by a newer EnvVault (version ${version}).`,
      "Upgrade EnvVault, or delete the file to start over.",
    );
  }

  const rawTokens = raw.tokens ?? [];
  if (!Array.isArray(rawTokens)) throw new ConfigError(`${source}: "tokens" must be an array.`);

  return {
    version,
    tokens: rawTokens.map((item, index) => validateEntry(item, `${source}.tokens[${index}]`)),
  };
}

export async function readTokenStore(home: string): Promise<TokenStore> {
  const raw = await readJsonFile<unknown>(tokenStorePath(home));
  if (raw === null) return emptyTokenStore();
  return validateTokenStore(raw);
}

export async function writeTokenStore(home: string, store: TokenStore): Promise<void> {
  await writeJsonAtomic(tokenStorePath(home), store, 0o600);
}

/** Every saved token, sorted by server URL then save time. */
export async function listServerTokens(home: string): Promise<StoredToken[]> {
  const store = await readTokenStore(home);
  return [...store.tokens].sort(
    (a, b) => a.url.localeCompare(b.url) || a.savedAt.localeCompare(b.savedAt),
  );
}

/** Tokens saved for one server URL (already normalised by the caller). */
export async function findServerTokens(home: string, url: string): Promise<StoredToken[]> {
  const store = await readTokenStore(home);
  return store.tokens
    .filter((entry) => entry.url === url)
    .sort((a, b) => a.savedAt.localeCompare(b.savedAt));
}

export interface SaveTokenResult {
  entry: StoredToken;
  created: boolean;
}

/**
 * Remember a token for a server. Saving the same value twice only refreshes
 * `lastUsedAt`, so repeated connects do not pile up duplicates.
 */
export async function saveServerToken(
  home: string,
  input: { url: string; token: string; label?: string | undefined },
): Promise<SaveTokenResult> {
  const store = await readTokenStore(home);
  const now = nowIso();
  const existing = store.tokens.find(
    (entry) => entry.url === input.url && entry.token === input.token,
  );

  if (existing !== undefined) {
    existing.lastUsedAt = now;
    if (input.label !== undefined && input.label !== "") existing.label = input.label;
    await writeTokenStore(home, store);
    return { entry: existing, created: false };
  }

  const entry: StoredToken = {
    url: input.url,
    token: input.token,
    savedAt: now,
    lastUsedAt: now,
  };
  if (input.label !== undefined && input.label !== "") entry.label = input.label;
  store.tokens.push(entry);
  await writeTokenStore(home, store);
  return { entry, created: true };
}

/** Forget tokens. Without `token`, removes every token for that URL. */
export async function removeServerToken(
  home: string,
  url: string,
  token?: string,
): Promise<number> {
  const store = await readTokenStore(home);
  const before = store.tokens.length;
  store.tokens = store.tokens.filter(
    (entry) => !(entry.url === url && (token === undefined || entry.token === token)),
  );
  const removed = before - store.tokens.length;
  if (removed > 0) await writeTokenStore(home, store);
  return removed;
}

/** Forget every saved token. Returns how many were removed. */
export async function clearServerTokens(home: string): Promise<number> {
  const store = await readTokenStore(home);
  const removed = store.tokens.length;
  if (removed > 0) await writeTokenStore(home, emptyTokenStore());
  return removed;
}
