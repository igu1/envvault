import { runUi } from "../ui/app";
import type { AppContext } from "../core/types";
import type { ParsedArgs } from "../utils/args";

/** `envvault ui` — interactive terminal UI (see `src/ui/app.ts`). */
export async function uiCommand(ctx: AppContext, _args: ParsedArgs): Promise<number> {
  return await runUi(ctx);
}
