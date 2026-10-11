import { afterEach, describe, expect, it } from "vitest";

import { remoteCommand } from "../src/commands/remote";
import { setCommand } from "../src/commands/set";
import { readServerConfig } from "../src/server/config";
import { parseControlOperation } from "../src/server/control";
import { sendControlOperation } from "../src/server/control-client";
import { createShareToken } from "../src/server/manage";
import { startShareServer } from "../src/server/service";
import type { RunningServer } from "../src/server/service";
import { loadVault } from "../src/core/vault";
import { openVault } from "../src/core/unlock";
import { parseArgs } from "../src/utils/args";
import { ExitCode, ShareAuthError, UsageError } from "../src/utils/errors";
import { createHarness, setupProject } from "./helpers";
import type { Harness } from "./helpers";

const running: RunningServer[] = [];
const harnesses: Harness[] = [];

afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
  for (const harness of harnesses.splice(0)) await harness.cleanup();
});

/** A server vault with a project, one global, and two tokens (control / read-only). */
async function controlServer(): Promise<{
  server: Harness;
  client: Harness;
  url: string;
  controlToken: string;
  readToken: string;
}> {
  const server = await createHarness();
  harnesses.push(server);
  await setupProject(server, "crono", "dev", { DATABASE_URL: "postgres://dev", DEV_ONLY: "dev-only" });
  server.state.stdin = "global-value";
  await setCommand(server.ctx, parseArgs(["GLOBAL_TOKEN", "--stdin", "--global"]));

  const controlToken = (await createShareToken(server.home, "control", { shares: "all", backup: false, control: true })).token;
  const readToken = (await createShareToken(server.home, "read", { shares: "all", backup: false })).token;

  const { key } = await openVault(server.ctx);
  const config = await readServerConfig(server.home);
  const handle = await startShareServer({
    home: server.home,
    config,
    vaultKey: key.key,
    version: "test",
    host: "127.0.0.1",
    port: 0,
  });
  running.push(handle);

  const client = await createHarness();
  harnesses.push(client);
  return { server, client, url: `http://127.0.0.1:${handle.port}`, controlToken, readToken };
}

describe("remote control: scope and parsing", () => {
  it("rejects an unknown operation", () => {
    expect(() => parseControlOperation({ op: "drop-everything" })).toThrow(UsageError);
  });

  it("rejects an invalid secret name before touching the server", () => {
    expect(() =>
      parseControlOperation({ op: "set", scope: { kind: "global" }, name: "bad name", value: "x" }),
    ).toThrow(/invalid "name"/);
  });

  it("refuses to build a remote scope without an explicit choice", async () => {
    const { client, url, controlToken } = await controlServer();
    await expect(
      remoteCommand(client.ctx, parseArgs([url, "list", "--token", controlToken])),
    ).rejects.toThrow(/Choose a remote scope/);
  });
});

describe("remote control: operations", () => {
  it("lists a project scope without globals", async () => {
    const { client, url, controlToken } = await controlServer();
    expect(
      await remoteCommand(client.ctx, parseArgs([url, "list", "--project", "crono", "--env", "dev", "--origins", "--token", controlToken])),
    ).toBe(ExitCode.Success);
    expect(client.output()).toContain("crono / dev");
    expect(client.output()).toMatch(/DATABASE_URL\s+environment/);
    expect(client.output()).not.toContain("GLOBAL_TOKEN");
  });

  it("lists globals only in the global scope", async () => {
    const { client, url, controlToken } = await controlServer();
    await remoteCommand(client.ctx, parseArgs([url, "list", "--global", "--json", "--token", controlToken]));
    expect(JSON.parse(client.output())).toEqual({
      scope: "Global",
      secrets: [{ name: "GLOBAL_TOKEN", origin: "global" }],
    });
  });

  it("writes a secret to the server vault through the encrypted channel", async () => {
    const { server, client, url, controlToken } = await controlServer();
    client.state.stdin = "postgres://new\n";
    await remoteCommand(client.ctx, parseArgs([url, "set", "NEW_KEY", "--stdin", "--project", "crono", "--env", "dev", "--token", controlToken]));

    const vault = await loadVault(server.home, server.state.password);
    expect(vault.projects.crono?.environments.dev?.secrets.NEW_KEY?.value).toBe("postgres://new");
  });

  it("never sends a secret value in plaintext on the wire", async () => {
    const { client, url, controlToken } = await controlServer();
    const bodies: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return original(input, init);
    }) as typeof fetch;
    try {
      client.state.stdin = "postgres://wire-secret";
      await remoteCommand(client.ctx, parseArgs([url, "set", "WIRE_KEY", "--stdin", "--project", "crono", "--env", "dev", "--token", controlToken]));
      await remoteCommand(client.ctx, parseArgs([url, "get", "DATABASE_URL", "--raw", "--project", "crono", "--env", "dev", "--token", controlToken]));
    } finally {
      globalThis.fetch = original;
    }
    expect(bodies.length).toBe(2);
    const wire = bodies.join("\n");
    expect(wire).not.toContain("postgres://wire-secret");
    expect(wire).not.toContain("postgres://dev");
    expect(wire).not.toContain("WIRE_KEY");
    expect(client.output()).toContain("postgres://dev");
  });

  it("reads a value back with --raw", async () => {
    const { client, url, controlToken } = await controlServer();
    await remoteCommand(client.ctx, parseArgs([url, "get", "DATABASE_URL", "--raw", "--project", "crono", "--env", "dev", "--token", controlToken]));
    expect(client.output()).toBe("postgres://dev");
  });

  it("deletes a secret from the server", async () => {
    const { server, client, url, controlToken } = await controlServer();
    await remoteCommand(client.ctx, parseArgs([url, "delete", "DEV_ONLY", "--project", "crono", "--env", "dev", "--yes", "--token", controlToken]));
    const vault = await loadVault(server.home, server.state.password);
    expect(vault.projects.crono?.environments.dev?.secrets.DEV_ONLY).toBeUndefined();
  });

  it("exports the project scope as env text without globals", async () => {
    const { client, url, controlToken } = await controlServer();
    await remoteCommand(client.ctx, parseArgs([url, "export", "--format", "env", "--project", "crono", "--env", "dev", "--token", controlToken]));
    expect(client.output()).toContain("DATABASE_URL=");
    expect(client.output()).not.toContain("GLOBAL_TOKEN");
  });

  it("manages projects and environments remotely", async () => {
    const { server, client, url, controlToken } = await controlServer();
    await remoteCommand(client.ctx, parseArgs([url, "project", "add", "atlas", "--env", "dev,prod", "--token", controlToken]));
    let vault = await loadVault(server.home, server.state.password);
    expect(Object.keys(vault.projects.atlas?.environments ?? {}).sort()).toEqual(["dev", "prod"]);

    client.stdout.length = 0;
    await remoteCommand(client.ctx, parseArgs([url, "project", "remove", "atlas", "--yes", "--token", controlToken]));
    vault = await loadVault(server.home, server.state.password);
    expect(vault.projects.atlas).toBeUndefined();
  });

  it("imports a .env file into a remote environment without overwriting by default", async () => {
    const { server, client, url, controlToken } = await controlServer();
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(client.cwd, "in.env"), "DATABASE_URL=changed\nNEW_ONE=1\n");
    await remoteCommand(client.ctx, parseArgs([url, "import", "in.env", "--project", "crono", "--env", "dev", "--token", controlToken]));
    const vault = await loadVault(server.home, server.state.password);
    expect(vault.projects.crono?.environments.dev?.secrets.DATABASE_URL?.value).toBe("postgres://dev");
    expect(vault.projects.crono?.environments.dev?.secrets.NEW_ONE?.value).toBe("1");
  });
});

describe("remote control: authorisation", () => {
  it("refuses a token without the control grant", async () => {
    const { client, url, readToken } = await controlServer();
    await expect(
      remoteCommand(client.ctx, parseArgs([url, "list", "--global", "--token", readToken])),
    ).rejects.toThrow(/not allowed to control the vault/);
  });

  it("refuses an unknown token", async () => {
    const { client, url } = await controlServer();
    const bogus = "evt_" + "a".repeat(43);
    await expect(
      remoteCommand(client.ctx, parseArgs([url, "list", "--global", "--token", bogus])),
    ).rejects.toThrow(ShareAuthError);
  });

  it("rejects a request whose token does not match the one that encrypted it", async () => {
    const { url, controlToken } = await controlServer();
    // The wrong token fails authentication before any vault data is touched.
    await expect(
      sendControlOperation(url, controlToken.slice(0, -1) + "x", { op: "projects" }),
    ).rejects.toThrow(ShareAuthError);
  });

  it("reports a clear error for a missing remote project", async () => {
    const { client, url, controlToken } = await controlServer();
    await expect(
      remoteCommand(client.ctx, parseArgs([url, "project", "remove", "missing", "--yes", "--token", controlToken])),
    ).rejects.toThrow(/Project not found: missing/);
  });
});
