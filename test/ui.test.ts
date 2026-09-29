import { describe, expect, it } from "vitest";

import { uiCommand } from "../src/commands/ui";
import { parseArgs } from "../src/utils/args";
import { createHarness } from "./helpers";

describe("ui/guard", () => {
  it("refuses to start without an interactive terminal", async () => {
    const h = await createHarness();
    try {
      h.ctx.io.stdinIsTTY = false;
      await expect(uiCommand(h.ctx, parseArgs([]))).rejects.toMatchObject({ exitCode: 2 });
    } finally {
      await h.cleanup();
    }
  });
});
