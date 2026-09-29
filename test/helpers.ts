import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initCommand } from "../src/commands/init";
import { projectCommand } from "../src/commands/project";
import { setCommand } from "../src/commands/set";
import { useCommand } from "../src/commands/use";
import type { AppContext, Clipboard, Io } from "../src/core/types";
import { parseArgs } from "../src/utils/args";

export interface HarnessState {
  stdin: string;
  password: string;
  clipboard: string | null;
  confirm: boolean;
}

export interface Harness {
  ctx: AppContext;
  home: string;
  cwd: string;
  stdout: string[];
  stderr: string[];
  state: HarnessState;
  output(): string;
  errors(): string;
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  cwd?: string;
  password?: string;
  stdin?: string;
}

/** Create an isolated EnvVault home + working directory for a test. */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "envvault-test-"));
  const home = join(root, "home");
  const cwd = options.cwd ?? join(root, "project");
  await mkdir(cwd, { recursive: true });

  const stdout: string[] = [];
  const stderr: string[] = [];
  const state: HarnessState = {
    stdin: options.stdin ?? "",
    password: options.password ?? "test-master-password",
    clipboard: null,
    confirm: true,
  };

  const io: Io = {
    stdout: (text) => {
      stdout.push(text);
    },
    stderr: (text) => {
      stderr.push(text);
    },
    isTTY: true,
    stdinIsTTY: true,
    readStdin: async () => state.stdin,
    promptHidden: async () => state.password,
    confirm: async () => state.confirm,
  };

  const clipboard: Clipboard = {
    copy: async (text) => {
      state.clipboard = text;
    },
    clear: async () => {
      state.clipboard = "";
    },
  };

  const env: NodeJS.ProcessEnv = { ...process.env, ENVVAULT_HOME: home, HOME: root };
  delete env.ENVVAULT_MASTER_PASSWORD;

  const ctx: AppContext = { cwd, home, env, io, clipboard };

  return {
    ctx,
    home,
    cwd,
    stdout,
    stderr,
    state,
    output: () => stdout.join("\n"),
    errors: () => stderr.join("\n"),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Initialize the vault, add a project/environment, bind cwd, and set secrets. */
export async function setupProject(
  harness: Harness,
  project: string,
  environment: string,
  secrets: Record<string, string> = {},
): Promise<void> {
  await initCommand(harness.ctx, parseArgs([]));
  await projectCommand(harness.ctx, parseArgs(["add", project, "--env", environment]));
  await useCommand(harness.ctx, parseArgs([`${project}/${environment}`]));
  for (const [name, value] of Object.entries(secrets)) {
    harness.state.stdin = value;
    const code = await setCommand(harness.ctx, parseArgs([name, "--stdin"]));
    if (code !== 0) throw new Error(`failed to set ${name}`);
  }
  harness.stdout.length = 0;
  harness.stderr.length = 0;
}

export async function writeProjectFile(
  harness: Harness,
  name: string,
  content: string,
): Promise<string> {
  const path = join(harness.cwd, name);
  await writeFile(path, content, "utf8");
  return path;
}
