import { createInterface } from "node:readline";

import type { Io } from "../core/types";
import { AuthError } from "./errors";

/** Read a single line from stdin without echoing it to the terminal. */
export async function promptHidden(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Non-interactive input: read one line, as when piping a password.
    const line = await readLine();
    return line;
  }

  process.stdout.write(label);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return await new Promise<string>((resolve, reject) => {
    let value = "";

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          // Ctrl+C
          cleanup();
          process.stdout.write("\n");
          reject(new AuthError("Aborted."));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= " ") value += char;
      }
    };

    stdin.on("data", onData);
  });
}

/** Read a single line from stdin, echoing normally. */
export async function readLine(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  return await new Promise<string>((resolve) => {
    let settled = false;
    rl.once("line", (line) => {
      settled = true;
      rl.close();
      resolve(line);
    });
    // stdin can end without a trailing newline (or be closed); resolve instead
    // of waiting forever.
    rl.once("close", () => {
      if (!settled) resolve("");
    });
  });
}

export async function confirm(label: string, defaultValue = false): Promise<boolean> {
  const suffix = defaultValue ? " [Y/n] " : " [y/N] ";
  process.stdout.write(label + suffix);
  const answer = (await readLine()).trim().toLowerCase();
  if (answer === "") return defaultValue;
  return answer === "y" || answer === "yes";
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Default `Io` implementation backed by the real terminal. */
export function createIo(): Io {
  return {
    stdout(text: string) {
      process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    },
    stderr(text: string) {
      process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
    },
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    stdinIsTTY: process.stdin.isTTY === true,
    readStdin,
    promptHidden,
    confirm,
  };
}
