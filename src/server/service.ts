/**
 * Server lifecycle: bind, report the effective address, and close cleanly.
 *
 * Kept separate from `http.ts` so the request handler can be unit-tested by
 * binding to an ephemeral port (`port: 0`) without any of the CLI concerns.
 */

import { ServerStartError } from "../utils/errors";
import { createShareServer } from "./http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { ShareServerHandle } from "./http";
import type { ServerConfig } from "./types";

export interface StartServerOptions {
  home: string;
  config: ServerConfig;
  vaultKey: Buffer;
  version: string;
  /** Override the bind address (used by tests with port 0). */
  host?: string | undefined;
  port?: number | undefined;
  onLog?: (line: string) => void;
  now?: () => string;
}

export interface RunningServer {
  handle: ShareServerHandle;
  server: Server;
  host: string;
  port: number;
  /** Normalised URLs a client can use. */
  urls: string[];
  close(): Promise<void>;
}

export async function startShareServer(options: StartServerOptions): Promise<RunningServer> {
  const host = options.host ?? options.config.host;
  const port = options.port ?? options.config.port;

  const handle = createShareServer({
    home: options.home,
    config: options.config,
    vaultKey: options.vaultKey,
    version: options.version,
    ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      handle.server.off("listening", onListening);
      reject(
        new ServerStartError(
          `Could not start the server on ${host}:${port}: ${error.message}`,
          "Another process may be using the port. Change it with `envvault server port <n>`.",
        ),
      );
    };
    const onListening = (): void => {
      handle.server.off("error", onError);
      resolve();
    };
    handle.server.once("error", onError);
    handle.server.once("listening", onListening);
    handle.server.listen(port, host);
  });

  const address = handle.server.address() as AddressInfo | null;
  const boundPort = address?.port ?? port;
  const boundHost = address?.address ?? host;

  const displayHosts =
    boundHost === "0.0.0.0" || boundHost === "::" ? ["127.0.0.1"] : [normaliseHost(boundHost)];
  const urls = displayHosts.map((entry) => `http://${entry}:${boundPort}`);

  return {
    handle,
    server: handle.server,
    host: boundHost,
    port: boundPort,
    urls,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        handle.server.close((error) => {
          if (error !== undefined && error !== null) reject(error);
          else resolve();
        });
      });
    },
  };
}

function normaliseHost(host: string): string {
  // IPv6 addresses need brackets in a URL.
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}
