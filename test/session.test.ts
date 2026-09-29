import { mkdir, stat, writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { clearSession, readSession, sessionPath, writeSession } from "../src/core/session";
import { formatDuration, parseDuration } from "../src/utils/duration";
import { createHarness } from "./helpers";

describe("duration", () => {
  it("parses durations with units", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("15m")).toBe(900_000);
    expect(parseDuration("8h")).toBe(28_800_000);
    expect(parseDuration("7d")).toBe(604_800_000);
    expect(parseDuration("2w")).toBe(1_209_600_000);
  });

  it("defaults a bare number to seconds", () => {
    expect(parseDuration("90")).toBe(90_000);
  });

  it("rejects invalid durations", () => {
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("8 x")).toBeNull();
    expect(parseDuration("-5m")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });

  it("formats durations for humans", () => {
    expect(formatDuration(8 * 60 * 60 * 1000)).toBe("8 hours");
    expect(formatDuration(24 * 60 * 60 * 1000)).toBe("1 day");
    expect(formatDuration(90 * 60 * 1000)).toBe("90 minutes");
    expect(formatDuration(30_000)).toBe("30 seconds");
  });
});

describe("session", () => {
  it("stores and reads a session with 0600 permissions", async () => {
    const harness = await createHarness();
    try {
      const key = Buffer.alloc(32, 7);
      const expiresAt = await writeSession(harness.home, key, 60_000);

      const session = await readSession(harness.home);
      expect(session).not.toBeNull();
      expect(session?.key.equals(key)).toBe(true);
      expect(session?.expiresAt).toBe(expiresAt);
      expect((await stat(sessionPath(harness.home))).mode & 0o777).toBe(0o600);
    } finally {
      await harness.cleanup();
    }
  });

  it("ignores and removes an expired session", async () => {
    const harness = await createHarness();
    try {
      await writeSession(harness.home, Buffer.alloc(32, 1), -1000);
      expect(await readSession(harness.home)).toBeNull();
      // Already removed, so there is nothing left to clear.
      expect(await clearSession(harness.home)).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  it("clears an active session", async () => {
    const harness = await createHarness();
    try {
      await writeSession(harness.home, Buffer.alloc(32, 2), 60_000);
      expect(await clearSession(harness.home)).toBe(true);
      expect(await clearSession(harness.home)).toBe(false);
      expect(await readSession(harness.home)).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("treats a corrupt session file as absent", async () => {
    const harness = await createHarness();
    try {
      await mkdir(harness.home, { recursive: true });
      await writeFile(sessionPath(harness.home), "{ not valid json", "utf8");
      expect(await readSession(harness.home)).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });
});
