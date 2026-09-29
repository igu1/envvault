/** Small network helpers shared by the server commands and the UI. */

import { networkInterfaces } from "node:os";

/** True for addresses that never leave the machine. */
export function isLoopback(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "::ffff:127.0.0.1"
  );
}

/** The wildcard bind address, reachable from the network. */
export function isWildcard(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

/** Non-internal IPv4 addresses, used to suggest a LAN URL. */
export function localNetworkAddresses(): string[] {
  const result: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) result.push(entry.address);
    }
  }
  return result;
}
