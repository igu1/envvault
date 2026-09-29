import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { copyCommand } from "../src/commands/copy";
import { deleteCommand } from "../src/commands/delete";
import { doctorCommand } from "../src/commands/doctor";
import { exportCommand } from "../src/commands/export";
import { getCommand } from "../src/commands/get";
import { importCommand } from "../src/commands/import";
import { initCommand } from "../src/commands/init";
import { listCommand } from "../src/commands/list";
import { lockCommand } from "../src/commands/lock";
import { projectCommand } from "../src/commands/project";
import { runCommand } from "../src/commands/run";
import { setCommand } from "../src/commands/set";
import { unlockCommand } from "../src/commands/unlock";
import { unuseCommand } from "../src/commands/unuse";
import { useCommand } from "../src/commands/use";
import { loadVault } from "../src/core/vault";
import { parseArgs } from "../src/utils/args";
import { ExitCode, SecretNotFoundError, WrongPasswordError } from "../src/utils/errors";
import { createHarness, setupProject, writeProjectFile } from "./helpers";

describe("commands/init", () => {
  it("creates an encrypted vault and no plaintext artefacts", async () => {
    const h = await createHarness();
    try {
      expect(await initCommand(h.ctx, parseArgs([]))).toBe(ExitCode.Success);
      expect(h.output()).toContain("EnvVault is ready.");

      const envelope = JSON.parse(await readFile(join(h.home, "vault.enc"), "utf8")) as {
        kdf: string;
        cipher: string;
      };
      expect(envelope.kdf).toBe("scrypt");
      expect(envelope.cipher).toBe("aes-256-gcm");

      const config = JSON.parse(await readFile(join(h.home, "config.json"), "utf8")) as {
        version: number;
      };
      expect(config.version).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  it("is idempotent and never overwrites an existing vault", async () => {
    const h = await createHarness();
    try {
      await initCommand(h.ctx, parseArgs([]));
      const firstEnvelope = await readFile(join(h.home, "vault.enc"), "utf8");

      h.stdout.length = 0;
      expect(await initCommand(h.ctx, parseArgs([]))).toBe(ExitCode.Success);
      expect(h.output()).toContain("already initialized");
      expect(await readFile(join(h.home, "vault.enc"), "utf8")).toBe(firstEnvelope);
    } finally {
      await h.cleanup();
    }
  });

  it("enforces a minimum master password length", async () => {
    const h = await createHarness({ password: "short" });
    try {
      await expect(initCommand(h.ctx, parseArgs([]))).rejects.toThrow(/at least 8/);
    } finally {
      await h.cleanup();
    }
  });
});

describe("commands/project", () => {
  it("adds, lists and removes projects", async () => {
    const h = await createHarness();
    try {
      await initCommand(h.ctx, parseArgs([]));
      expect(await projectCommand(h.ctx, parseArgs(["add", "crono", "--env", "dev"]))).toBe(0);
      expect(await projectCommand(h.ctx, parseArgs(["add", "justblocks"]))).toBe(0);

      h.stdout.length = 0;
      await projectCommand(h.ctx, parseArgs(["list"]));
      expect(h.output()).toContain("crono");
      expect(h.output()).toContain("justblocks");

      expect(await projectCommand(h.ctx, parseArgs(["remove", "crono", "--yes"]))).toBe(0);
      h.stdout.length = 0;
      await projectCommand(h.ctx, parseArgs(["list"]));
      expect(h.output()).not.toContain("crono");
      expect(h.output()).toContain("justblocks");
    } finally {
      await h.cleanup();
    }
  });

  it("refuses to recreate an existing project", async () => {
    const h = await createHarness();
    try {
      await initCommand(h.ctx, parseArgs([]));
      await projectCommand(h.ctx, parseArgs(["add", "crono", "--env", "dev"]));
      expect(await projectCommand(h.ctx, parseArgs(["add", "crono"]))).toBe(ExitCode.Error);
    } finally {
      await h.cleanup();
    }
  });

  it("adds environments to an existing project", async () => {
    const h = await createHarness();
    try {
      await initCommand(h.ctx, parseArgs([]));
      await projectCommand(h.ctx, parseArgs(["add", "crono", "--env", "dev"]));

      h.stdout.length = 0;
      expect(await projectCommand(h.ctx, parseArgs(["add", "crono", "--env", "production"]))).toBe(
        ExitCode.Success,
      );
      expect(h.output()).toContain("Created environment: crono/production");
      expect(h.output()).not.toContain("Created project");

      // Re-adding an existing environment reports it and changes nothing.
      h.stderr.length = 0;
      expect(await projectCommand(h.ctx, parseArgs(["add", "crono", "--env", "production"]))).toBe(
        ExitCode.Error,
      );
      expect(h.errors()).toContain("Environment already exists: crono/production");

      h.stdout.length = 0;
      await projectCommand(h.ctx, parseArgs(["list", "--environments"]));
      expect(h.output()).toContain("crono");
      expect(h.output()).toContain("dev");
      expect(h.output()).toContain("production");
    } finally {
      await h.cleanup();
    }
  });

  it("adds several environments at once from a comma-separated list", async () => {
    const h = await createHarness();
    try {
      await initCommand(h.ctx, parseArgs([]));
      expect(
        await projectCommand(h.ctx, parseArgs(["add", "multi", "--env", "dev,staging,production"])),
      ).toBe(ExitCode.Success);
      expect(h.output()).toContain("Created environment: multi/staging");

      h.stdout.length = 0;
      await projectCommand(h.ctx, parseArgs(["list", "--environments"]));
      expect(h.output()).toContain("dev");
      expect(h.output()).toContain("staging");
      expect(h.output()).toContain("production");
    } finally {
      await h.cleanup();
    }
  });

  it("lets secrets be stored in a newly added environment", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { DATABASE_URL: "dev-db" });
      await projectCommand(h.ctx, parseArgs(["add", "crono", "--env", "production"]));
      await useCommand(h.ctx, parseArgs(["crono/production"]));

      h.state.stdin = "prod-db";
      expect(await setCommand(h.ctx, parseArgs(["DATABASE_URL", "--stdin"]))).toBe(
        ExitCode.Success,
      );
      h.stdout.length = 0;
      await getCommand(h.ctx, parseArgs(["DATABASE_URL", "--raw"]));
      expect(h.output()).toBe("prod-db");
    } finally {
      await h.cleanup();
    }
  });
});

describe("commands/set + get", () => {
  it("stores a secret and masks it on read", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { DATABASE_URL: "postgres://secret" });

      expect(await getCommand(h.ctx, parseArgs(["DATABASE_URL"]))).toBe(0);
      expect(h.output()).toContain("DATABASE_URL=");
      expect(h.output()).not.toContain("postgres://secret");
      expect(h.output()).toMatch(/•/);

      h.stdout.length = 0;
      h.stderr.length = 0;
      expect(await getCommand(h.ctx, parseArgs(["DATABASE_URL", "--reveal"]))).toBe(0);
      expect(h.output()).toContain("postgres://secret");
      expect(h.errors()).toContain("Warning");
    } finally {
      await h.cleanup();
    }
  });

  it("reports a missing secret", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", {});
      await expect(getCommand(h.ctx, parseArgs(["NOPE"]))).rejects.toBeInstanceOf(
        SecretNotFoundError,
      );
    } finally {
      await h.cleanup();
    }
  });

  it("supports --raw output for scripts", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { TOKEN: "only-the-value" });
      await getCommand(h.ctx, parseArgs(["TOKEN", "--reveal", "--raw"]));
      expect(h.output()).toBe("only-the-value");
    } finally {
      await h.cleanup();
    }
  });

  it("fails cleanly with a wrong master password", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { TOKEN: "value" });
      h.state.password = "definitely-wrong";
      await expect(getCommand(h.ctx, parseArgs(["TOKEN"]))).rejects.toBeInstanceOf(
        WrongPasswordError,
      );
    } finally {
      await h.cleanup();
    }
  });
});

describe("commands/scopes", () => {
  it("manages global secrets", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", {});
      h.state.stdin = "global-value";
      expect(await setCommand(h.ctx, parseArgs(["GLOBAL_TOKEN", "--stdin", "--global"]))).toBe(0);
      expect(h.output()).toContain("global");

      h.stdout.length = 0;
      await getCommand(h.ctx, parseArgs(["GLOBAL_TOKEN", "--global", "--raw"]));
      expect(h.output()).toBe("global-value");
    } finally {
      await h.cleanup();
    }
  });

  it("manages project shared secrets", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", {});
      h.state.stdin = "acme";
      expect(
        await setCommand(
          h.ctx,
          parseArgs(["COMPANY_NAME", "--stdin", "--project", "crono", "--shared"]),
        ),
      ).toBe(0);

      h.stdout.length = 0;
      await listCommand(h.ctx, parseArgs(["--project", "crono", "--shared"]));
      expect(h.output()).toContain("crono / shared");
      expect(h.output()).toContain("COMPANY_NAME");
    } finally {
      await h.cleanup();
    }
  });

  it("shows origins and masks every value in list output", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { DATABASE_URL: "db-value" });
      h.state.stdin = "global-value";
      await setCommand(h.ctx, parseArgs(["OPENAI_API_KEY", "--stdin", "--global"]));

      h.stdout.length = 0;
      await listCommand(h.ctx, parseArgs(["--origins"]));
      const out = h.output();
      expect(out).toContain("crono / dev");
      expect(out).toMatch(/DATABASE_URL\s+environment/);
      expect(out).toMatch(/OPENAI_API_KEY\s+global/);
      expect(out).not.toContain("db-value");
    } finally {
      await h.cleanup();
    }
  });

  it("falls back to globals when no directory context can be resolved", async () => {
    const h = await createHarness();
    try {
      await initCommand(h.ctx, parseArgs([]));
      await projectCommand(h.ctx, parseArgs(["add", "crono", "--env", "dev"]));
      h.state.stdin = "global-value";
      await setCommand(h.ctx, parseArgs(["GLOBAL_TOKEN", "--stdin", "--global"]));

      h.stdout.length = 0;
      expect(await listCommand(h.ctx, parseArgs([]))).toBe(ExitCode.Success);
      const out = h.output();
      expect(out).toContain("Global (no project context)");
      expect(out).toContain("GLOBAL_TOKEN");
      expect(out).not.toContain("global-value");
      expect(out).toContain("not bound to a project");
    } finally {
      await h.cleanup();
    }
  });

  it("still errors when an explicit scope is unknown", async () => {
    const h = await createHarness();
    try {
      await initCommand(h.ctx, parseArgs([]));
      await projectCommand(h.ctx, parseArgs(["add", "crono", "--env", "dev"]));
      await expect(listCommand(h.ctx, parseArgs(["--project", "missing"]))).rejects.toMatchObject({
        exitCode: 3,
      });
    } finally {
      await h.cleanup();
    }
  });
});

describe("commands/global fallback", () => {
  it("stores and reads globals when the directory is not bound", async () => {
    const h = await createHarness();
    try {
      await initCommand(h.ctx, parseArgs([]));
      await projectCommand(h.ctx, parseArgs(["add", "crono", "--env", "dev"]));

      h.state.stdin = "global-value";
      expect(await setCommand(h.ctx, parseArgs(["TOKEN", "--stdin"]))).toBe(ExitCode.Success);
      expect(h.output()).toContain("in global");
      expect(h.errors()).toContain("No project context");

      h.stdout.length = 0;
      await getCommand(h.ctx, parseArgs(["TOKEN", "--raw"]));
      expect(h.output()).toBe("global-value");
    } finally {
      await h.cleanup();
    }
  });

  it("still errors when an explicit scope is unknown", async () => {
    const h = await createHarness();
    try {
      await initCommand(h.ctx, parseArgs([]));
      await projectCommand(h.ctx, parseArgs(["add", "crono", "--env", "dev"]));
      h.state.stdin = "x";
      await expect(
        setCommand(h.ctx, parseArgs(["TOKEN", "--stdin", "--project", "missing"])),
      ).rejects.toMatchObject({ exitCode: 3 });
    } finally {
      await h.cleanup();
    }
  });

  it("reports a miss when the secret only exists in a project", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { PROJECT_ONLY: "p" });
      await unuseCommand(h.ctx, parseArgs([]));
      await expect(getCommand(h.ctx, parseArgs(["PROJECT_ONLY"]))).rejects.toBeInstanceOf(
        SecretNotFoundError,
      );
    } finally {
      await h.cleanup();
    }
  });
});

describe("commands/delete", () => {
  it("deletes with --yes", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { A: "1" });
      expect(await deleteCommand(h.ctx, parseArgs(["A", "--yes"]))).toBe(0);
      await expect(getCommand(h.ctx, parseArgs(["A"]))).rejects.toBeInstanceOf(SecretNotFoundError);
    } finally {
      await h.cleanup();
    }
  });

  it("refuses destructive actions without --yes in a non-interactive session", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { A: "1" });
      h.ctx.io.isTTY = false;
      await expect(deleteCommand(h.ctx, parseArgs(["A"]))).rejects.toMatchObject({ exitCode: 2 });
    } finally {
      await h.cleanup();
    }
  });
});

describe("commands/import", () => {
  it("imports a .env file and reports duplicates", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", {});
      h.state.stdin = "existing";
      await setCommand(h.ctx, parseArgs(["EXISTING", "--stdin"]));

      await writeProjectFile(
        h,
        ".env",
        ["# comment", "DATABASE_URL=postgres://x", 'QUOTED="hello world"', "EXISTING=old"].join("\n"),
      );

      h.stdout.length = 0;
      expect(await importCommand(h.ctx, parseArgs([".env"]))).toBe(0);
      expect(h.output()).toContain("EXISTING already exists.");
      expect(h.output()).toContain("Imported 2 secrets");

      h.stdout.length = 0;
      await importCommand(h.ctx, parseArgs([".env", "--overwrite"]));
      expect(h.output()).toContain("Imported 3 secrets");

      const vault = await loadVault(h.home, h.state.password);
      expect(vault.projects.crono?.environments.dev?.secrets.QUOTED?.value).toBe("hello world");
      expect(vault.projects.crono?.environments.dev?.secrets.EXISTING?.value).toBe("old");
    } finally {
      await h.cleanup();
    }
  });

  it("fails when the file does not exist", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", {});
      await expect(importCommand(h.ctx, parseArgs([".env"]))).rejects.toMatchObject({
        exitCode: 1,
      });
    } finally {
      await h.cleanup();
    }
  });
});

describe("commands/export", () => {
  it("exports env, json and shell formats", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { A: "1", B: "two words" });

      await exportCommand(h.ctx, parseArgs([]));
      expect(h.output()).toContain("A=1");

      h.stdout.length = 0;
      await exportCommand(h.ctx, parseArgs(["--format", "json"]));
      expect(h.output()).toContain('"A": "1"');

      h.stdout.length = 0;
      await exportCommand(h.ctx, parseArgs(["--format", "shell"]));
      expect(h.output()).toContain("export A='1'");
    } finally {
      await h.cleanup();
    }
  });

  it("writes plaintext files with 0600 permissions, only on request", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { A: "1" });
      h.stderr.length = 0;
      await exportCommand(h.ctx, parseArgs(["--output", "exported.env"]));

      expect(h.errors()).toContain("plaintext");
      const path = join(h.cwd, "exported.env");
      expect(await readFile(path, "utf8")).toContain("A=1");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await h.cleanup();
    }
  });

  it("rejects unknown formats", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", {});
      await expect(exportCommand(h.ctx, parseArgs(["--format", "yaml"]))).rejects.toMatchObject({
        exitCode: 2,
      });
    } finally {
      await h.cleanup();
    }
  });
});

describe("commands/run", () => {
  it("injects secrets into a child process", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { DATABASE_URL: "postgres://injected" });
      const outFile = join(h.cwd, "child.txt");
      const script = `require("node:fs").writeFileSync(${JSON.stringify(outFile)}, process.env.DATABASE_URL ?? "MISSING")`;
      expect(await runCommand(h.ctx, [process.execPath, "-e", script])).toBe(0);
      expect(await readFile(outFile, "utf8")).toBe("postgres://injected");
    } finally {
      await h.cleanup();
    }
  });

  it("forwards the child exit code", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", {});
      expect(await runCommand(h.ctx, [process.execPath, "-e", "process.exit(7)"])).toBe(7);
    } finally {
      await h.cleanup();
    }
  });

  it("requires a command", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", {});
      await expect(runCommand(h.ctx, [])).rejects.toMatchObject({ exitCode: 2 });
    } finally {
      await h.cleanup();
    }
  });
});

describe("commands/copy", () => {
  it("copies to the clipboard without printing the value", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { TOKEN: "copy-me" });
      expect(await copyCommand(h.ctx, parseArgs(["TOKEN", "--clear-after", "0"]))).toBe(0);
      expect(h.state.clipboard).toBe("copy-me");
      expect(h.output()).toContain("Copied TOKEN");
      expect(h.output()).not.toContain("copy-me");
    } finally {
      await h.cleanup();
    }
  });
});

describe("commands/doctor", () => {
  it("reports missing and unused variables", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { DATABASE_URL: "x", UNUSED_KEY: "y" });
      await writeProjectFile(
        h,
        "app.ts",
        ["process.env.DATABASE_URL;", "process.env.MISSING_KEY;"].join("\n"),
      );

      expect(await doctorCommand(h.ctx, parseArgs([]))).toBe(0);
      const out = h.output();
      expect(out).toContain("MISSING_KEY");
      expect(out).toContain("app.ts:2");
      expect(out).toContain("UNUSED_KEY");
      expect(out).toContain("1 missing");
      expect(out).toContain("1 possibly unused");

      expect(await doctorCommand(h.ctx, parseArgs(["--strict"]))).toBe(ExitCode.Missing);
    } finally {
      await h.cleanup();
    }
  });
});

describe("commands/unuse", () => {
  it("disconnects the current directory without needing the master password", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { A: "1" });

      // Prove no vault access is involved: no TTY and no password available.
      h.ctx.io.isTTY = false;
      h.stdout.length = 0;
      expect(await unuseCommand(h.ctx, parseArgs([]))).toBe(ExitCode.Success);
      expect(h.output()).toContain("Disconnected");

      h.stdout.length = 0;
      expect(await listCommand(h.ctx, parseArgs([]))).toBe(ExitCode.Success);
      expect(h.output()).toContain("not bound to a project");
    } finally {
      await h.cleanup();
    }
  });

  it("is a no-op when there is no mapping", async () => {
    const h = await createHarness();
    try {
      await initCommand(h.ctx, parseArgs([]));
      expect(await unuseCommand(h.ctx, parseArgs([]))).toBe(ExitCode.Success);
      expect(h.output()).toContain("No directory mapping");
    } finally {
      await h.cleanup();
    }
  });

  it("accepts an explicit directory", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", {});
      h.stdout.length = 0;
      expect(await unuseCommand(h.ctx, parseArgs([h.cwd]))).toBe(ExitCode.Success);
      expect(h.output()).toContain("Disconnected");
    } finally {
      await h.cleanup();
    }
  });

  it("explains an inherited mapping instead of silently failing", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", {});
      const nested = join(h.cwd, "backend");
      await mkdir(nested, { recursive: true });
      h.ctx.cwd = nested;

      expect(await unuseCommand(h.ctx, parseArgs([]))).toBe(ExitCode.Error);
      expect(h.errors()).toContain("inherits crono/dev");
      expect(h.errors()).toContain(`envvault unuse ${h.cwd}`);
    } finally {
      await h.cleanup();
    }
  });

  it("points at .envvault.json when that is the source of the context", async () => {
    const h = await createHarness();
    try {
      await writeProjectFile(
        h,
        ".envvault.json",
        JSON.stringify({ project: "demo", environment: "dev" }),
      );
      expect(await unuseCommand(h.ctx, parseArgs([]))).toBe(ExitCode.Error);
      expect(h.errors()).toContain(".envvault.json");
    } finally {
      await h.cleanup();
    }
  });
});

describe("commands/use", () => {
  it("rejects an unknown environment", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", {});
      await expect(useCommand(h.ctx, parseArgs(["crono/nope"]))).rejects.toMatchObject({
        exitCode: 3,
      });
    } finally {
      await h.cleanup();
    }
  });
});

describe("commands/unlock + lock", () => {
  it("lets commands run without the master password while unlocked", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { DATABASE_URL: "postgres://original" });

      h.stdout.length = 0;
      expect(await unlockCommand(h.ctx, parseArgs(["--ttl", "1h"]))).toBe(ExitCode.Success);
      expect(h.output()).toContain("Vault unlocked");
      expect(h.output()).toContain("1 hour");

      // Any prompt now returns a wrong password; the session must be used.
      h.state.password = "wrong-password";

      h.stdout.length = 0;
      expect(await listCommand(h.ctx, parseArgs([]))).toBe(ExitCode.Success);
      expect(h.output()).toContain("DATABASE_URL");

      // Writes keep the session valid because the salt no longer rotates.
      h.state.stdin = "updated-value";
      expect(await setCommand(h.ctx, parseArgs(["DATABASE_URL", "--stdin"]))).toBe(ExitCode.Success);
      h.stdout.length = 0;
      await getCommand(h.ctx, parseArgs(["DATABASE_URL", "--raw"]));
      expect(h.output()).toContain("updated-value");

      // And `run` injects without prompting.
      const outFile = join(h.cwd, "session-run.txt");
      const script = `require("node:fs").writeFileSync(${JSON.stringify(outFile)}, process.env.DATABASE_URL ?? "MISSING")`;
      expect(await runCommand(h.ctx, [process.execPath, "-e", script])).toBe(0);
      expect(await readFile(outFile, "utf8")).toBe("updated-value");
    } finally {
      await h.cleanup();
    }
  });

  it("prompts again after locking", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { A: "1" });
      await unlockCommand(h.ctx, parseArgs(["--ttl", "1h"]));
      expect(await lockCommand(h.ctx)).toBe(ExitCode.Success);

      h.state.password = "wrong-password";
      await expect(listCommand(h.ctx, parseArgs([]))).rejects.toBeInstanceOf(WrongPasswordError);
    } finally {
      await h.cleanup();
    }
  });

  it("can be bypassed with ENVVAULT_NO_SESSION", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { A: "1" });
      await unlockCommand(h.ctx, parseArgs(["--ttl", "1h"]));

      h.ctx.env.ENVVAULT_NO_SESSION = "1";
      h.state.password = "wrong-password";
      await expect(listCommand(h.ctx, parseArgs([]))).rejects.toBeInstanceOf(WrongPasswordError);
    } finally {
      await h.cleanup();
    }
  });

  it("rejects an invalid --ttl", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", {});
      await expect(unlockCommand(h.ctx, parseArgs(["--ttl", "soon"]))).rejects.toMatchObject({
        exitCode: 2,
      });
    } finally {
      await h.cleanup();
    }
  });
});
