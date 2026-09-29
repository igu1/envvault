import { describe, expect, it } from "vitest";

import {
  encodeEnvValue,
  serializeEnv,
  serializeJson,
  serializeSecrets,
  serializeShell,
  shellQuote,
} from "../src/env/serializer";

describe("env/serializers", () => {
  const secrets = { B_KEY: "second", A_KEY: "first", SPACED: "hello world" };

  it("sorts keys for stable output", () => {
    const output = serializeEnv(secrets);
    expect(output.indexOf("A_KEY")).toBeLessThan(output.indexOf("B_KEY"));
  });

  it("quotes values that need it", () => {
    expect(serializeEnv({ SPACED: "hello world" })).toBe('SPACED="hello world"\n');
    expect(serializeEnv({ PLAIN: "value" })).toBe("PLAIN=value\n");
    expect(serializeEnv({ EMPTY: "" })).toBe('EMPTY=""\n');
  });

  it("produces valid JSON", () => {
    const parsed = JSON.parse(serializeJson({ A: "1", B: "two words" })) as Record<string, string>;
    expect(parsed).toEqual({ A: "1", B: "two words" });
  });

  it("produces shell exports with safe quoting", () => {
    expect(serializeShell({ NAME: "it's here" })).toBe(
      `export NAME='it'\\''s here'\n`,
    );
    expect(shellQuote("plain")).toBe("'plain'");
  });

  it("dispatches by format", () => {
    expect(serializeSecrets({ A: "1" }, "json")).toContain('"A"');
    expect(serializeSecrets({ A: "1" }, "shell")).toBe("export A='1'\n");
    expect(serializeSecrets({ A: "1" }, "env")).toBe("A=1\n");
  });

  it("encodes env values that contain shell-sensitive characters", () => {
    expect(encodeEnvValue("a$b")).toBe('"a\\$b"');
    expect(encodeEnvValue("hash#tag")).toBe('"hash#tag"');
    expect(encodeEnvValue("up")).toBe("up");
  });
});
