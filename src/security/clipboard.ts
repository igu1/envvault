import { spawn } from "node:child_process";

import type { Clipboard } from "../core/types";
import { ConfigError } from "../utils/errors";

export interface ClipboardCommand {
  command: string;
  args: string[];
}

/**
 * Pick the platform clipboard tool. Linux tries Wayland first, then the two
 * common X11 helpers; the caller falls back through the list at runtime.
 */
export function clipboardCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ClipboardCommand[] {
  if (platform === "darwin") return [{ command: "pbcopy", args: [] }];
  if (platform === "win32") return [{ command: "clip", args: [] }];

  const candidates: ClipboardCommand[] = [];
  if (env.WAYLAND_DISPLAY !== undefined) candidates.push({ command: "wl-copy", args: [] });
  candidates.push({ command: "xclip", args: ["-selection", "clipboard"] });
  candidates.push({ command: "xsel", args: ["--clipboard", "--input"] });
  return candidates;
}

async function writeToCommand(command: ClipboardCommand, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, command.args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new ConfigError(`${command.command} exited with code ${code ?? 1}.`));
    });
    child.stdin?.end(text);
  });
}

export interface ClipboardOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Injection point used by tests. */
  write?: (command: ClipboardCommand, text: string) => Promise<void>;
}

export function createClipboard(options: ClipboardOptions = {}): Clipboard {
  const candidates = clipboardCandidates(
    options.platform ?? process.platform,
    options.env ?? process.env,
  );
  const write = options.write ?? writeToCommand;

  const copy = async (text: string): Promise<void> => {
    for (const candidate of candidates) {
      try {
        await write(candidate, text);
        return;
      } catch {
        // Try the next clipboard backend.
      }
    }
    throw new ConfigError(
      "No clipboard tool is available on this system.",
      "Install wl-clipboard, xclip or xsel, or use `envvault get --reveal` instead.",
    );
  };

  return {
    copy,
    clear: async () => {
      // Best effort: an empty clipboard is the safest "cleared" state we can
      // reach without a native clipboard API.
      await copy("");
    },
  };
}
