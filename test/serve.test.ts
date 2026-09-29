import { describe, expect, it } from "vitest";

import { setCommand } from "../src/commands/set";
import { readEnvelopeFile } from "../src/core/storage";
import { openVault } from "../src/core/unlock";
import { readServerConfig } from "../src/server/config";
import { createShareToken, revokeShareToken, upsertShare } from "../src/server/manage";
import { decryptShareEnvelope } from "../src/server/share";
import { startShareServer } from "../src/server/service";
import { parseArgs } from "../src/utils/args";
import { createHarness, setupProject } from "./helpers";
import type { Harness } from "./helpers";
import type { RunningServer } from "../src/server/service";
import type { EncryptedEnvelope } from "../src/core/types";

async function startServer(h: Harness): Promise<RunningServer> {
  const { key } = await openVault(h.ctx);
  const config = await readServerConfig(h.home);
  return await startShareServer({
    home: h.home,
    config,
    vaultKey: key.key,
    version: "9.9.9",
    host: "127.0.0.1",
    port: 0,
    now: () => "2026-03-03T00:00:00.000Z",
  });
}

async function base(h: Harness): Promise<{ running: RunningServer; url: string }> {
  const running = await startServer(h);
  return { running, url: `http://127.0.0.1:${running.port}` };
}

describe("serve/http", () => {
  it("exposes an unauthenticated health endpoint", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { DATABASE_URL: "postgres://dev" });
      const { running, url } = await base(h);
      try {
        const res = await fetch(`${url}/health`);
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ service: "envvault", version: "9.9.9" });
      } finally {
        await running.close();
      }
    } finally {
      await h.cleanup();
    }
  });

  it("requires a valid token for shares", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { DATABASE_URL: "postgres://dev" });
      await upsertShare(h.home, { project: "crono", environment: "dev", keys: ["DATABASE_URL"] });
      await createShareToken(h.home, "laptop", { shares: "all", backup: false });
      const { running, url } = await base(h);
      try {
        expect((await fetch(`${url}/shares`)).status).toBe(401);
        expect(
          (
            await fetch(`${url}/shares`, {
              headers: { authorization: "Bearer evt_not-a-real-token-value" },
            })
          ).status,
        ).toBe(401);
      } finally {
        await running.close();
      }
    } finally {
      await h.cleanup();
    }
  });

  it("serves an encrypted payload that only the token can open", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { DATABASE_URL: "postgres://dev", STRIPE_KEY: "sk_1" });
      await upsertShare(h.home, { project: "crono", environment: "dev", keys: ["DATABASE_URL"] });
      const { token } = await createShareToken(h.home, "laptop", { shares: "all", backup: false });

      const { running, url } = await base(h);
      try {
        const listRes = await fetch(`${url}/shares`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const list = (await listRes.json()) as { shares: Array<{ keys: string[] }> };
        expect(list.shares).toHaveLength(1);
        expect(list.shares[0]?.keys).toEqual(["DATABASE_URL"]);

        const shareRes = await fetch(`${url}/shares/crono/dev`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(shareRes.status).toBe(200);
        const body = (await shareRes.json()) as { envelope: EncryptedEnvelope };
        // The wire payload is ciphertext.
        expect(JSON.stringify(body)).not.toContain("postgres://dev");

        const payload = await decryptShareEnvelope(body.envelope, token);
        expect(payload.secrets).toEqual({ DATABASE_URL: "postgres://dev" });
        expect(payload.exportedAt).toBe("2026-03-03T00:00:00.000Z");
      } finally {
        await running.close();
      }
    } finally {
      await h.cleanup();
    }
  });

  it("honours per-token share grants", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { DATABASE_URL: "postgres://dev" });
      await upsertShare(h.home, { project: "crono", environment: "dev", keys: ["DATABASE_URL"] });
      await upsertShare(h.home, { project: "crono", environment: "other", keys: ["DATABASE_URL"] });
      const { token } = await createShareToken(h.home, "restricted", {
        shares: ["crono/other"],
        backup: false,
      });

      const { running, url } = await base(h);
      try {
        const list = (await (
          await fetch(`${url}/shares`, { headers: { authorization: `Bearer ${token}` } })
        ).json()) as { shares: Array<{ environment: string }> };
        expect(list.shares.map((share) => share.environment)).toEqual(["other"]);

        const denied = await fetch(`${url}/shares/crono/dev`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(denied.status).toBe(403);
      } finally {
        await running.close();
      }
    } finally {
      await h.cleanup();
    }
  });

  it("refuses a revoked token immediately", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { DATABASE_URL: "postgres://dev" });
      await upsertShare(h.home, { project: "crono", environment: "dev", keys: ["DATABASE_URL"] });
      const { token, record } = await createShareToken(h.home, "laptop", {
        shares: "all",
        backup: false,
      });

      const { running, url } = await base(h);
      try {
        const auth = { authorization: `Bearer ${token}` };
        expect((await fetch(`${url}/shares`, { headers: auth })).status).toBe(200);

        await revokeShareToken(h.home, record.id);
        // No restart: the running server re-reads its configuration.
        expect((await fetch(`${url}/shares`, { headers: auth })).status).toBe(401);
      } finally {
        await running.close();
      }
    } finally {
      await h.cleanup();
    }
  });

  it("answers 404 and 405 for unknown or unsupported requests", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { DATABASE_URL: "postgres://dev" });
      const { token } = await createShareToken(h.home, "laptop", { shares: "all", backup: false });
      const { running, url } = await base(h);
      try {
        expect((await fetch(`${url}/nope`)).status).toBe(404);
        expect((await fetch(`${url}/shares`, { method: "POST" })).status).toBe(405);
        expect(
          (
            await fetch(`${url}/shares/crono/missing`, {
              headers: { authorization: `Bearer ${token}` },
            })
          ).status,
        ).toBe(404);
      } finally {
        await running.close();
      }
    } finally {
      await h.cleanup();
    }
  });

  it("reads live vault changes without a restart", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { DATABASE_URL: "postgres://old" });
      await upsertShare(h.home, { project: "crono", environment: "dev", keys: ["DATABASE_URL"] });
      const { token } = await createShareToken(h.home, "laptop", { shares: "all", backup: false });

      const { running, url } = await base(h);
      try {
        const first = await decryptShareEnvelope(
          (
            (await (
              await fetch(`${url}/shares/crono/dev`, {
                headers: { authorization: `Bearer ${token}` },
              })
            ).json()) as { envelope: EncryptedEnvelope }
          ).envelope,
          token,
        );
        expect(first.secrets.DATABASE_URL).toBe("postgres://old");

        h.state.stdin = "postgres://new";
        await setCommand(h.ctx, parseArgs(["DATABASE_URL", "--stdin"]));

        const second = await decryptShareEnvelope(
          (
            (await (
              await fetch(`${url}/shares/crono/dev`, {
                headers: { authorization: `Bearer ${token}` },
              })
            ).json()) as { envelope: EncryptedEnvelope }
          ).envelope,
          token,
        );
        expect(second.secrets.DATABASE_URL).toBe("postgres://new");
      } finally {
        await running.close();
      }
    } finally {
      await h.cleanup();
    }
  });

  it("gates backups behind the backup grant", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { DATABASE_URL: "postgres://dev" });
      const { token: noBackup } = await createShareToken(h.home, "nobackup", {
        shares: "all",
        backup: false,
      });
      const { token: withBackup } = await createShareToken(h.home, "backup", {
        shares: "all",
        backup: true,
      });
      const envelope = await readEnvelopeFile(h.home);

      const { running, url } = await base(h);
      try {
        expect(
          (
            await fetch(`${url}/backups`, { headers: { authorization: `Bearer ${noBackup}` } })
          ).status,
        ).toBe(403);

        const put = await fetch(`${url}/backups/laptop`, {
          method: "PUT",
          headers: { authorization: `Bearer ${withBackup}`, "content-type": "application/json" },
          body: JSON.stringify({ envelope }),
        });
        expect(put.status).toBe(200);

        const list = (await (
          await fetch(`${url}/backups`, { headers: { authorization: `Bearer ${withBackup}` } })
        ).json()) as { backups: Array<{ id: string }> };
        expect(list.backups.map((backup) => backup.id)).toEqual(["laptop"]);

        const get = (await (
          await fetch(`${url}/backups/laptop`, {
            headers: { authorization: `Bearer ${withBackup}` },
          })
        ).json()) as { envelope: EncryptedEnvelope };
        expect(get.envelope).toEqual(envelope);

        expect(
          (
            await fetch(`${url}/backups/laptop`, {
              method: "DELETE",
              headers: { authorization: `Bearer ${withBackup}` },
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await fetch(`${url}/backups/laptop`, {
              method: "DELETE",
              headers: { authorization: `Bearer ${withBackup}` },
            })
          ).status,
        ).toBe(404);
      } finally {
        await running.close();
      }
    } finally {
      await h.cleanup();
    }
  });
});
