import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/cli.ts",
    "src/index.ts"
  ],
  format: ["esm"],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  // Bundle the one runtime dependency so the desktop app can ship dist/cli.js
  // on its own, without a node_modules tree next to it.
  noExternal: ["@clack/prompts"]
});
