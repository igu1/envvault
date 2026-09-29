import { spawn } from "node:child_process";
import os from "node:os";

import { CommandNotFoundError, DockerNotFoundError } from "./errors";
import { isNotFound } from "./fs";

export interface RunProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Forward SIGINT/SIGTERM/SIGHUP to the child. Defaults to true. */
  forwardSignals?: boolean;
}

export interface RunProcessResult {
  code: number;
  signal: NodeJS.Signals | null;
}

/**
 * Spawn a child process with inherited stdio and forward its exit code.
 *
 * Used by `run`, `docker run`, `docker compose` and `docker build`. Signals
 * are forwarded so interactive children (dev servers, shells) shut down
 * cleanly when the user presses Ctrl+C.
 */
export async function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<RunProcessResult> {
  const spawnOptions: Parameters<typeof spawn>[2] = {
    stdio: "inherit",
    shell: false,
  };
  if (options.cwd !== undefined) spawnOptions.cwd = options.cwd;
  if (options.env !== undefined) spawnOptions.env = options.env;

  return await new Promise<RunProcessResult>((resolve, reject) => {
    const child = spawn(command, [...args], spawnOptions);

    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = new Map<NodeJS.Signals, () => void>();

    if (options.forwardSignals !== false) {
      for (const signal of signals) {
        const handler = () => {
          try {
            child.kill(signal);
          } catch {
            // Child already exited.
          }
        };
        handlers.set(signal, handler);
        process.on(signal, handler);
      }
    }

    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      if (isNotFound(error)) reject(new CommandNotFoundError(command));
      else reject(error);
    });

    child.on("exit", (code, signal) => {
      cleanup();
      resolve({ code: code ?? signalExitCode(signal), signal });
    });
  });
}

export interface CaptureResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command and capture its output. Never inherits stdio. */
export async function runProcessCapture(
  command: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<CaptureResult> {
  const spawnOptions: Parameters<typeof spawn>[2] = { stdio: ["ignore", "pipe", "pipe"] };
  if (options.cwd !== undefined) spawnOptions.cwd = options.cwd;
  if (options.env !== undefined) spawnOptions.env = options.env;

  return await new Promise<CaptureResult>((resolve, reject) => {
    const child = spawn(command, [...args], spawnOptions);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (isNotFound(error)) reject(new CommandNotFoundError(command));
      else reject(error);
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Check whether the Docker CLI is available. */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    const result = await runProcessCapture("docker", ["--version"]);
    return result.code === 0;
  } catch {
    return false;
  }
}

export async function requireDocker(): Promise<void> {
  if (!(await isDockerAvailable())) throw new DockerNotFoundError();
}

export function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  const number = os.constants.signals[signal];
  return number === undefined ? 1 : 128 + number;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
