/**
 * The sharing HTTP server.
 *
 * Deliberately built on `node:http` with no framework, matching the project's
 * zero-runtime-dependency posture. The handler reads `server.json` on every
 * request, so enabling/disabling, editing a share, or revoking a token takes
 * effect immediately without restarting the process.
 *
 * Security posture:
 *   - disabled by default; `serve` refuses to start unless `enabled` is true
 *   - binds loopback unless the user opts into the network
 *   - every share/backup route requires a bearer token
 *   - share payloads are encrypted with a key derived from that token, so the
 *     response is ciphertext even on a plain HTTP connection
 *   - only explicitly allowlisted key names are ever read from the vault
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";

import { loadVaultWithKey } from "../core/vault";
import {
  deleteBackup,
  listBackups,
  readBackup,
  writeBackup,
  MAX_BACKUP_BYTES,
} from "./backup";
import { readServerConfig } from "./config";
import { authenticateToken, bearerFrom } from "./tokens";
import { buildSharePayload, encryptSharePayload } from "./share";
import { CURRENT_SERVER_VERSION, shareRef } from "./types";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { ServerConfig, ShareSummary } from "./types";
import type { AuthenticatedToken } from "./tokens";

/** Request bodies are backups; allow a little slack over the backup limit. */
const MAX_BODY_BYTES = MAX_BACKUP_BYTES + 1024 * 1024;
/** Bound the in-memory token cache so it cannot grow without limit. */
const TOKEN_CACHE_LIMIT = 16;

export interface ShareServerOptions {
  home: string;
  /** Startup configuration; re-read from disk on every request. */
  config: ServerConfig;
  /**
   * Derived vault key. The server holds the key (not the master password) and
   * re-reads the encrypted vault on each request so edits are picked up live.
   */
  vaultKey: Buffer;
  version: string;
  onLog?: (line: string) => void;
  now?: () => string;
}

export interface ShareServerHandle {
  server: Server;
  /** Clears the token cache (used when configuration changes). */
  invalidateTokenCache(): void;
}

class BodyTooLargeError extends Error {}
class BadJsonError extends Error {}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): void {
  sendJson(res, status, { error: code, message }, headers);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BadJsonError();
  }
}

function grantAllowsShare(token: AuthenticatedToken, project: string, environment: string): boolean {
  if (token.token.grant.shares === "all") return true;
  return token.token.grant.shares.includes(shareRef(project, environment));
}

function summarise(config: ServerConfig, token: AuthenticatedToken): ShareSummary[] {
  return config.shares
    .filter((share) => grantAllowsShare(token, share.project, share.environment))
    .map((share) => {
      const summary: ShareSummary = {
        project: share.project,
        environment: share.environment,
        keys: share.keys,
        updatedAt: share.updatedAt,
      };
      if (share.label !== undefined) summary.label = share.label;
      return summary;
    })
    .sort((a, b) =>
      shareRef(a.project, a.environment).localeCompare(shareRef(b.project, b.environment)),
    );
}

function clientLabel(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

/** Build the EnvVault sharing server. The caller owns `listen`/`close`. */
export function createShareServer(options: ShareServerOptions): ShareServerHandle {
  const { home, vaultKey, version } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const log = options.onLog ?? (() => undefined);
  let fallbackConfig = options.config;

  // Raw token -> authenticated result. Bounded, per-process, never persisted.
  const tokenCache = new Map<string, AuthenticatedToken>();

  /** Always serve from the current file so revocations apply immediately. */
  async function currentConfig(): Promise<ServerConfig> {
    try {
      fallbackConfig = await readServerConfig(home);
    } catch {
      // A malformed file must not silently downgrade access; keep the last
      // known-good configuration instead of serving an empty one.
    }
    return fallbackConfig;
  }

  async function authenticate(
    req: IncomingMessage,
    config: ServerConfig,
  ): Promise<AuthenticatedToken | null> {
    const presented = bearerFrom(req.headers.authorization);
    if (presented === undefined) return null;

    const cached = tokenCache.get(presented);
    if (cached !== undefined && config.tokens.some((token) => token.id === cached.token.id)) {
      return cached;
    }
    if (cached !== undefined) tokenCache.delete(presented);

    const authenticated = await authenticateToken(config, presented);
    if (authenticated === null) return null;

    if (tokenCache.size >= TOKEN_CACHE_LIMIT) {
      const oldest = tokenCache.keys().next().value;
      if (oldest !== undefined) tokenCache.delete(oldest);
    }
    tokenCache.set(presented, authenticated);
    return authenticated;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const method = req.method ?? "GET";
    let status = 200;

    let segments: string[];
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      segments = url.pathname
        .split("/")
        .filter((segment) => segment !== "")
        .map((segment) => decodeURIComponent(segment));
    } catch {
      sendError(res, 400, "bad_request", "Malformed request path.");
      return;
    }

    const path = segments.join("/");

    try {
      status = await route(req, res, segments, await currentConfig());
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        status = 413;
        sendError(res, 413, "payload_too_large", "Request body is too large.");
      } else if (error instanceof BadJsonError) {
        status = 400;
        sendError(res, 400, "bad_json", "Request body is not valid JSON.");
      } else {
        status = 500;
        const message = error instanceof Error ? error.message : String(error);
        sendError(res, 500, "server_error", message);
      }
    } finally {
      log(`${method} /${path} ${status} ${Date.now() - started}ms ${clientLabel(req)}`);
    }
  }

  function methodNotAllowed(res: ServerResponse, allow: string[]): number {
    sendError(res, 405, "method_not_allowed", "Method not allowed.", { allow: allow.join(", ") });
    return 405;
  }

  async function route(
    req: IncomingMessage,
    res: ServerResponse,
    segments: string[],
    config: ServerConfig,
  ): Promise<number> {
    const method = req.method ?? "GET";
    const [head, second, third] = segments;

    if (head === "health") {
      if (method !== "GET") return methodNotAllowed(res, ["GET"]);
      sendJson(res, 200, {
        service: "envvault",
        version,
        serverVersion: CURRENT_SERVER_VERSION,
        shares: config.shares.length,
      });
      return 200;
    }

    if (head === "shares") {
      if (method !== "GET") return methodNotAllowed(res, ["GET"]);
      const token = await authenticate(req, config);
      if (token === null) {
        sendError(res, 401, "unauthorized", "A valid share token is required.");
        return 401;
      }
      if (second === undefined) {
        sendJson(res, 200, { shares: summarise(config, token) });
        return 200;
      }
      if (third === undefined) {
        sendError(res, 404, "not_found", "Unknown route.");
        return 404;
      }
      return await serveShare(res, config, token, second, third);
    }

    if (head === "backups") {
      return await routeBackups(req, res, config, method, second);
    }

    sendError(res, 404, "not_found", "Unknown route.");
    return 404;
  }

  async function serveShare(
    res: ServerResponse,
    config: ServerConfig,
    token: AuthenticatedToken,
    project: string,
    environment: string,
  ): Promise<number> {
    const share = config.shares.find(
      (candidate) => candidate.project === project && candidate.environment === environment,
    );
    if (share === undefined) {
      sendError(res, 404, "not_found", `No share for ${project}/${environment}.`);
      return 404;
    }
    if (!grantAllowsShare(token, project, environment)) {
      sendError(res, 403, "forbidden", "This token is not allowed to read that share.");
      return 403;
    }

    const vault = await loadVaultWithKey(home, vaultKey);
    const payload = buildSharePayload(vault, share, now());
    const envelope = encryptSharePayload(
      payload,
      token.key,
      Buffer.from(token.token.salt, "base64"),
    );
    sendJson(res, 200, { envelope });
    return 200;
  }

  async function routeBackups(
    req: IncomingMessage,
    res: ServerResponse,
    config: ServerConfig,
    method: string,
    id: string | undefined,
  ): Promise<number> {
    const token = await authenticate(req, config);
    if (token === null) {
      sendError(res, 401, "unauthorized", "A valid share token is required.");
      return 401;
    }
    if (!token.token.grant.backup) {
      sendError(res, 403, "forbidden", "This token is not allowed to use backups.");
      return 403;
    }

    if (id === undefined) {
      if (method !== "GET") return methodNotAllowed(res, ["GET"]);
      sendJson(res, 200, { backups: await listBackups(home) });
      return 200;
    }

    switch (method) {
      case "GET": {
        const backup = await readBackup(home, id);
        if (backup === null) {
          sendError(res, 404, "not_found", `No backup named ${id}.`);
          return 404;
        }
        sendJson(res, 200, { envelope: backup.envelope, info: backup.info });
        return 200;
      }
      case "PUT": {
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        const envelope =
          typeof parsed === "object" && parsed !== null && "envelope" in parsed
            ? (parsed as { envelope: unknown }).envelope
            : parsed;
        const info = await writeBackup(home, id, envelope, now());
        sendJson(res, 200, { ok: true, info });
        return 200;
      }
      case "DELETE": {
        const removed = await deleteBackup(home, id);
        if (!removed) {
          sendError(res, 404, "not_found", `No backup named ${id}.`);
          return 404;
        }
        sendJson(res, 200, { ok: true });
        return 200;
      }
      default:
        return methodNotAllowed(res, ["GET", "PUT", "DELETE"]);
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  return {
    server,
    invalidateTokenCache: () => {
      tokenCache.clear();
    },
  };
}

/** Stable short hash used in logs to refer to a token without revealing it. */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}
