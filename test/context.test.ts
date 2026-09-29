import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  findContextMapping,
  removeContextsForProject,
  removeDirectoryContext,
  resolveDirectoryContext,
  setDirectoryContext,
} from "../src/core/context";
import { createHarness, writeProjectFile } from "./helpers";

describe("context/findContextMapping", () => {
  const contexts = {
    "/srv/proj": { project: "crono", environment: "dev" },
    "/srv/proj/backend": { project: "crono", environment: "production" },
    "/srv/other": { project: "other", environment: "dev" },
  };

  it("matches an exact directory", () => {
    expect(findContextMapping(contexts, "/srv/proj")?.mapping.project).toBe("crono");
  });

  it("inherits a parent mapping for nested directories", () => {
    const match = findContextMapping(contexts, "/srv/proj/frontend/src");
    expect(match?.directory).toBe("/srv/proj");
    expect(match?.mapping.environment).toBe("dev");
  });

  it("prefers the most specific child mapping", () => {
    const match = findContextMapping(contexts, "/srv/proj/backend/api");
    expect(match?.directory).toBe("/srv/proj/backend");
    expect(match?.mapping.environment).toBe("production");
  });

  it("returns null when nothing matches", () => {
    expect(findContextMapping(contexts, "/tmp/elsewhere")).toBeNull();
  });

  it("does not match sibling prefixes", () => {
    expect(findContextMapping(contexts, "/srv/project-other")).toBeNull();
  });
});

describe("context/resolveDirectoryContext", () => {
  it("resolves from contexts.json including parent inheritance", async () => {
    const harness = await createHarness();
    try {
      await setDirectoryContext(harness.home, harness.cwd, {
        project: "crono",
        environment: "dev",
      });
      const nested = join(harness.cwd, "backend");
      const resolved = await resolveDirectoryContext(harness.home, nested);
      expect(resolved).toMatchObject({
        project: "crono",
        environment: "dev",
        source: "contexts",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("falls back to a project-local .envvault.json", async () => {
    const harness = await createHarness();
    try {
      await writeProjectFile(
        harness,
        ".envvault.json",
        JSON.stringify({ project: "demo", environment: "production" }),
      );
      const resolved = await resolveDirectoryContext(harness.home, harness.cwd);
      expect(resolved).toMatchObject({
        project: "demo",
        environment: "production",
        source: "project-config",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("prefers contexts.json over .envvault.json", async () => {
    const harness = await createHarness();
    try {
      await writeProjectFile(
        harness,
        ".envvault.json",
        JSON.stringify({ project: "from-file", environment: "dev" }),
      );
      await setDirectoryContext(harness.home, harness.cwd, {
        project: "from-contexts",
        environment: "dev",
      });
      const resolved = await resolveDirectoryContext(harness.home, harness.cwd);
      expect(resolved?.project).toBe("from-contexts");
    } finally {
      await harness.cleanup();
    }
  });

  it("returns null when there is no mapping", async () => {
    const harness = await createHarness();
    try {
      expect(await resolveDirectoryContext(harness.home, harness.cwd)).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });
});

describe("context/removeDirectoryContext", () => {
  it("removes only the exact mapping and reports whether one existed", async () => {
    const harness = await createHarness();
    try {
      await setDirectoryContext(harness.home, "/srv/a", { project: "one", environment: "dev" });
      await setDirectoryContext(harness.home, "/srv/a/sub", {
        project: "one",
        environment: "prod",
      });

      expect(await removeDirectoryContext(harness.home, "/srv/a")).toBe(true);
      expect(await removeDirectoryContext(harness.home, "/srv/a")).toBe(false);

      // The more specific child mapping must be untouched.
      const child = await resolveDirectoryContext(harness.home, "/srv/a/sub");
      expect(child?.environment).toBe("prod");
    } finally {
      await harness.cleanup();
    }
  });
});

describe("context/removeContextsForProject", () => {
  it("removes only mappings for the given project", async () => {
    const harness = await createHarness();
    try {
      await setDirectoryContext(harness.home, "/srv/a", { project: "one", environment: "dev" });
      await setDirectoryContext(harness.home, "/srv/b", { project: "two", environment: "dev" });
      const removed = await removeContextsForProject(harness.home, "one");
      expect(removed).toEqual(["/srv/a"]);
      expect(await resolveDirectoryContext(harness.home, "/srv/a")).toBeNull();
      expect((await resolveDirectoryContext(harness.home, "/srv/b"))?.project).toBe("two");
    } finally {
      await harness.cleanup();
    }
  });
});
