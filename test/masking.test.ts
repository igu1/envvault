import { describe, expect, it } from "vitest";

import { isMasked, maskPartial, maskSecret } from "../src/security/masking";
import { SecretValue, maskRecord, wipe } from "../src/security/memory";

describe("security/masking", () => {
  it("fully masks a secret without leaking any characters", () => {
    const value = "sk-example-123456789";
    const masked = maskSecret(value);
    expect(isMasked(masked)).toBe(true);
    expect(masked).not.toContain("sk");
    expect(masked).not.toContain("789");
    expect(masked.length).toBeGreaterThanOrEqual(8);
  });

  it("never returns fewer than 8 dots", () => {
    expect(maskSecret("x")).toBe("•".repeat(8));
    expect(maskSecret("")).toBe("•".repeat(8));
  });

  it("caps the mask length so long secrets do not leak their length", () => {
    expect(maskSecret("x".repeat(500)).length).toBe(20);
  });

  it("supports a partial hint only when explicitly requested", () => {
    expect(maskPartial("sk-example-123456789")).toBe("sk••••••789");
    expect(maskPartial("short")).toBe("•".repeat(8));
  });
});

describe("security/memory", () => {
  it("wipes buffers", () => {
    const buffer = Buffer.from("secret");
    wipe(buffer);
    expect(buffer.every((byte) => byte === 0)).toBe(true);
  });

  it("SecretValue refuses to reveal itself via toString/toJSON", () => {
    const secret = new SecretValue("super-secret-value");
    expect(String(secret)).not.toContain("super-secret-value");
    expect(JSON.stringify({ secret })).not.toContain("super-secret-value");
    expect(secret.reveal()).toBe("super-secret-value");
  });

  it("maskRecord masks every value", () => {
    const masked = maskRecord({ A: "value-one", B: "value-two" });
    expect(Object.keys(masked)).toEqual(["A", "B"]);
    expect(isMasked(masked.A as string)).toBe(true);
    expect(isMasked(masked.B as string)).toBe(true);
  });
});
