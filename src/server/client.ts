/**
 * Client for the EnvVault sharing server.
 *
 * Uses the global `fetch` (Node 20+) and only ever sends/receives ciphertext on
 * share routes. Errors are mapped onto the project's error taxonomy so the CLI
 * prints a readable message instead of a fetch stack trace.
 */

import { NetworkError, ShareAuthError, ShareNotFoundError } from "../utils/errors";
import type { EncryptedEnvelope } from "../core/types";
import type { BackupInfo, ShareSummary } from "./types";

export const DEFAULT_TIMEOUT_MS = 15_000;

/** Accept `host:port`, `http://host:port` and `https://…`; strip trailing slashes. */
export function normaliseServerUrl(input: string): string {
  let value = input.trim();
  if (value === "") throw new NetworkError("A server URL is required.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `http://${value}`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NetworkError(`Not a valid server URL: ${input}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new NetworkError(`Unsupported protocol: ${url.protocol}`, "Use http:// or https://.");
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

interface RequestOptions {
  method?: string;
  token?: string | undefined;
  body?: unknown;
  timeoutMs?: number;
}

interface ServerErrorBody {
  error?: string;
  message?: string;
}

export async function serverRequest<T>(
  baseUrl: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    response = await fetch(url, init);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new NetworkError(
      `Could not reach ${url}: ${reason}`,
      "Check the address, that `envvault serve` is running, and that the port is reachable.",
    );
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text !== "") {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const body = (parsed ?? {}) as ServerErrorBody;
    const message = body.message ?? `Request failed with status ${response.status}.`;
    if (response.status === 401) throw new ShareAuthError(message);
    if (response.status === 403) throw new ShareAuthError(message);
    if (response.status === 404) throw new ShareNotFoundError(message);
    throw new NetworkError(message);
  }

  return parsed as T;
}

export interface HealthResponse {
  service: string;
  version: string;
  serverVersion: number;
  shares: number;
}

export async function fetchHealth(
  baseUrl: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<HealthResponse> {
  const health = await serverRequest<HealthResponse>(baseUrl, "/health", { timeoutMs });
  if (health?.service !== "envvault") {
    throw new NetworkError(
      `${baseUrl} is not an EnvVault server.`,
      "Check the address and port.",
    );
  }
  return health;
}

export async function fetchShares(baseUrl: string, token: string): Promise<ShareSummary[]> {
  const result = await serverRequest<{ shares: ShareSummary[] }>(baseUrl, "/shares", { token });
  return result.shares ?? [];
}

export async function fetchShareEnvelope(
  baseUrl: string,
  token: string,
  project: string,
  environment: string,
): Promise<EncryptedEnvelope> {
  const path = `/shares/${encodeURIComponent(project)}/${encodeURIComponent(environment)}`;
  const result = await serverRequest<{ envelope: EncryptedEnvelope }>(baseUrl, path, { token });
  if (result?.envelope === undefined) {
    throw new NetworkError("The server returned no envelope for that share.");
  }
  return result.envelope;
}

export async function listRemoteBackups(baseUrl: string, token: string): Promise<BackupInfo[]> {
  const result = await serverRequest<{ backups: BackupInfo[] }>(baseUrl, "/backups", { token });
  return result.backups ?? [];
}

export async function downloadRemoteBackup(
  baseUrl: string,
  token: string,
  id: string,
): Promise<{ envelope: EncryptedEnvelope; info: BackupInfo }> {
  return await serverRequest<{ envelope: EncryptedEnvelope; info: BackupInfo }>(
    baseUrl,
    `/backups/${encodeURIComponent(id)}`,
    { token },
  );
}

export async function uploadRemoteBackup(
  baseUrl: string,
  token: string,
  id: string,
  envelope: EncryptedEnvelope,
): Promise<BackupInfo> {
  const result = await serverRequest<{ ok: boolean; info: BackupInfo }>(
    baseUrl,
    `/backups/${encodeURIComponent(id)}`,
    { method: "PUT", token, body: { envelope } },
  );
  return result.info;
}

export async function deleteRemoteBackup(
  baseUrl: string,
  token: string,
  id: string,
): Promise<void> {
  await serverRequest<{ ok: boolean }>(baseUrl, `/backups/${encodeURIComponent(id)}`, {
    method: "DELETE",
    token,
  });
}
