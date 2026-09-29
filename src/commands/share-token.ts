/**
 * Client-side share token acquisition.
 *
 * Priority: `--token`, then `ENVVAULT_SHARE_TOKEN`, then a token previously
 * saved for that server URL, then an interactive prompt. A token that worked is
 * remembered on the device (unless `--no-save` or `ENVVAULT_NO_TOKEN_STORE`),
 * so `connect` and `sync` only ask once per server.
 */

import { flagBool, flagString } from "../utils/args";
import { UsageError } from "../utils/errors";
import { formatWarning } from "../utils/output";
import { isPlainHttpToRemote } from "../server/net";
import { assertTokenShape } from "../server/tokens";
import {
  findServerTokens,
  maskToken,
  saveServerToken,
  tokenStorePath,
} from "../server/token-store";
import { askSelect } from "../ui/prompts";
import type { AppContext } from "../core/types";
import type { ParsedArgs } from "../utils/args";

export const SHARE_TOKEN_VAR = "ENVVAULT_SHARE_TOKEN";
export const NO_TOKEN_STORE_VAR = "ENVVAULT_NO_TOKEN_STORE";

/** Sentinel for "type a token instead of picking a saved one". */
const ENTER_NEW = "\u0000enter-new";

export type TokenSource = "flag" | "environment" | "store" | "prompt";

export interface ResolvedShareToken {
  token: string;
  source: TokenSource;
}

/** True when the device store is switched off for this process. */
export function tokenStoreDisabled(ctx: AppContext): boolean {
  return ctx.env[NO_TOKEN_STORE_VAR] !== undefined;
}

/**
 * Resolve the token to use for `baseUrl`, but never store it — call
 * `rememberShareToken` once the token has actually been accepted.
 */
export async function resolveShareToken(
  ctx: AppContext,
  args: ParsedArgs,
  baseUrl: string,
): Promise<ResolvedShareToken> {
  const fromFlag = flagString(args.flags, "token");
  if (fromFlag !== undefined && fromFlag.trim() !== "") {
    const token = fromFlag.trim();
    assertTokenShape(token);
    return { token, source: "flag" };
  }

  const fromEnv = ctx.env[SHARE_TOKEN_VAR];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    const token = fromEnv.trim();
    assertTokenShape(token);
    return { token, source: "environment" };
  }

  if (!tokenStoreDisabled(ctx)) {
    const saved = await findServerTokens(ctx.home, baseUrl);
    if (saved.length === 1) {
      return { token: saved[0]!.token, source: "store" };
    }
    if (saved.length > 1) {
      if (!ctx.io.stdinIsTTY) {
        throw new UsageError(
          `${saved.length} tokens are saved for ${baseUrl}.`,
          `Choose one with --token, or start over with:\n\n  envvault tokens remove ${baseUrl}`,
        );
      }
      const choice = await askSelect({
        message: `Token for ${baseUrl}`,
        options: [
          ...saved.map((entry) => ({
            value: entry.token,
            label: `${entry.label ?? "saved"}  ${maskToken(entry.token)}`,
          })),
          { value: ENTER_NEW, label: "Enter a different token…" },
        ],
      });
      if (choice === null) throw new UsageError("Cancelled.");
      if (choice !== ENTER_NEW) return { token: choice, source: "store" };
    }
  }

  if (!ctx.io.stdinIsTTY) {
    throw new UsageError(
      "A share token is required.",
      `Pass --token <token> or set ${SHARE_TOKEN_VAR}.`,
    );
  }

  const entered = await ctx.io.promptHidden("Share token: ");
  if (entered.trim() === "") throw new UsageError("A share token is required.");
  const token = entered.trim();
  assertTokenShape(token);
  return { token, source: "prompt" };
}

export interface RememberResult {
  saved: boolean;
  created: boolean;
}

/** Persist a token that the server has accepted. */
export async function rememberShareToken(
  ctx: AppContext,
  args: ParsedArgs,
  baseUrl: string,
  token: string,
  label?: string | undefined,
): Promise<RememberResult> {
  if (tokenStoreDisabled(ctx) || flagBool(args.flags, "no-save")) {
    return { saved: false, created: false };
  }
  const { created } = await saveServerToken(ctx.home, {
    url: baseUrl,
    token,
    ...(label === undefined ? {} : { label }),
  });
  return { saved: true, created };
}

/** Tell the user where the token went the first time we save it. */
export function notifyTokenSaved(ctx: AppContext, baseUrl: string, result: RememberResult): void {
  if (!result.saved || !result.created) return;
  ctx.io.stdout(
    `Token saved for ${baseUrl}. Forget it with \`envvault tokens remove ${baseUrl}\`.`,
  );
}

/** Explain why a stored credential is being rejected. */
export function staleTokenHint(ctx: AppContext, baseUrl: string): string {
  return [
    "If the token was saved for you earlier, replace it:",
    "",
    `  envvault tokens remove ${baseUrl}`,
    `  envvault connect ${baseUrl} --token <token>`,
    "",
    `Saved tokens live in ${tokenStorePath(ctx.home)}.`,
  ].join("\n");
}

/**
 * Warn when a token is about to cross a network in the clear.
 *
 * Share *payloads* are encrypted with a key derived from the token, so a
 * passive observer cannot read them from the response — but the token itself
 * travels in the `Authorization` header on every request, and that same token
 * derives the key. On plain HTTP the encryption buys nothing.
 */
export function warnPlainHttpTokenExposure(ctx: AppContext, baseUrl: string): void {
  if (!isPlainHttpToRemote(baseUrl)) return;
  const secure = baseUrl.replace(/^http:/, "https:");
  ctx.io.stderr(
    formatWarning(
      `sending your share token unencrypted to ${baseUrl}. Anyone on the network path can read it and use it to decrypt your shares.`,
    ),
  );
  ctx.io.stderr(`If the server supports TLS, use ${secure} instead.`);
}
