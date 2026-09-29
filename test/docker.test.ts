import { describe, expect, it } from "vitest";

import { dockerCommand } from "../src/commands/docker";
import { getDockerSettings } from "../src/docker/config";
import { buildDockerBuildArgs } from "../src/docker/build";
import { buildDockerComposeArgs } from "../src/docker/compose";
import { buildDockerRunArgs } from "../src/docker/run";
import {
  buildDockerPlan,
  dockerPlanExitCode,
  formatDockerPlan,
  hasMissingPlanSecrets,
} from "../src/docker/plan";
import { selectSecrets, unionServiceSecrets } from "../src/docker/secrets";
import type { DockerSettings } from "../src/docker/config";
import { ExitCode } from "../src/utils/errors";
import { createHarness, setupProject, writeProjectFile } from "./helpers";

const SETTINGS: DockerSettings = {
  mode: "env",
  services: {
    backend: ["DATABASE_URL", "REDIS_URL", "SECRET_KEY"],
    worker: ["DATABASE_URL", "REDIS_URL"],
    frontend: ["PUBLIC_API_URL"],
  },
  buildSecrets: ["NPM_TOKEN"],
};

describe("docker/arg builders", () => {
  it("injects secrets by name, never by value", () => {
    const args = buildDockerRunArgs(["--rm", "-p", "8000:8000", "my-image"], ["DATABASE_URL", "REDIS_URL"]);
    expect(args).toEqual([
      "--env",
      "DATABASE_URL",
      "--env",
      "REDIS_URL",
      "--rm",
      "-p",
      "8000:8000",
      "my-image",
    ]);
    expect(args.join(" ")).not.toContain("=");
  });

  it("passes compose arguments through unchanged", () => {
    const input = ["up", "-d", "--build"];
    expect(buildDockerComposeArgs(input)).toEqual(input);
  });

  it("uses BuildKit secret mounts for builds", () => {
    expect(buildDockerBuildArgs(["."], ["NPM_TOKEN"])).toEqual([
      "--secret",
      "id=npm_token,env=NPM_TOKEN",
      ".",
    ]);
  });
});

describe("docker/selectSecrets", () => {
  it("uses the union of configured services when none is named", () => {
    const selection = selectSecrets(SETTINGS, ["DATABASE_URL", "REDIS_URL", "SECRET_KEY"]);
    expect(selection.names).toEqual(["DATABASE_URL", "REDIS_URL", "SECRET_KEY"]);
    expect(selection.missing).toEqual(["PUBLIC_API_URL"]);
    expect(selection.unrestricted).toBe(false);
  });

  it("honours a specific service allowlist", () => {
    const selection = selectSecrets(SETTINGS, ["DATABASE_URL", "REDIS_URL", "SECRET_KEY"], {
      service: "worker",
    });
    expect(selection.names).toEqual(["DATABASE_URL", "REDIS_URL"]);
    expect(selection.names).not.toContain("SECRET_KEY");
  });

  it("does not leak every secret to an unconfigured service", () => {
    const selection = selectSecrets(SETTINGS, ["DATABASE_URL", "SECRET_KEY"], {
      service: "frontend",
    });
    expect(selection.names).toEqual([]);
    expect(selection.missing).toEqual(["PUBLIC_API_URL"]);
  });

  it("is unrestricted when no allowlist is configured", () => {
    const settings: DockerSettings = { mode: "env", services: {}, buildSecrets: [] };
    const selection = selectSecrets(settings, ["A", "B"]);
    expect(selection.unrestricted).toBe(true);
    expect(selection.names).toEqual(["A", "B"]);
  });

  it("throws for an unknown service", () => {
    expect(() => selectSecrets(SETTINGS, ["A"], { service: "nope" })).toThrow();
  });

  it("unions service secrets", () => {
    expect(unionServiceSecrets(SETTINGS)).toEqual([
      "DATABASE_URL",
      "PUBLIC_API_URL",
      "REDIS_URL",
      "SECRET_KEY",
    ]);
  });
});

describe("docker/plan", () => {
  it("reports presence and absence per service", () => {
    const plan = buildDockerPlan("crono", "production", SETTINGS, {
      DATABASE_URL: "x",
      REDIS_URL: "y",
    });
    expect(plan.availableCount).toBe(2);
    expect(plan.serviceCount).toBe(3);
    const backend = plan.services.find((service) => service.name === "backend");
    expect(backend?.present).toEqual(["DATABASE_URL", "REDIS_URL"]);
    expect(backend?.missing).toEqual(["SECRET_KEY"]);
    expect(hasMissingPlanSecrets(plan)).toBe(true);
    expect(dockerPlanExitCode(plan)).toBe(ExitCode.Missing);
  });

  it("formats a plan without any secret values", () => {
    const plan = buildDockerPlan("crono", "production", SETTINGS, {
      DATABASE_URL: "super-secret-value",
      REDIS_URL: "another-secret",
      SECRET_KEY: "third",
      PUBLIC_API_URL: "public",
      NPM_TOKEN: "npm-secret",
    });
    const output = formatDockerPlan(plan);
    expect(output).toContain("EnvVault Docker Plan");
    expect(output).toContain("5 secrets available");
    expect(output).toContain("3 services configured");
    expect(output).toContain("No secret values displayed.");
    expect(output).not.toContain("super-secret-value");
    expect(hasMissingPlanSecrets(plan)).toBe(false);
    expect(dockerPlanExitCode(plan)).toBe(ExitCode.Success);
  });
});

describe("docker/getDockerSettings", () => {
  it("defaults to env mode with no allowlists", () => {
    expect(getDockerSettings(null)).toEqual({ mode: "env", services: {}, buildSecrets: [] });
  });
});

describe("docker/plan command", () => {
  it("plans configured services and exits non-zero on missing secrets", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "production", {
        DATABASE_URL: "db-secret",
        REDIS_URL: "redis-secret",
      });
      await writeProjectFile(
        h,
        ".envvault.json",
        JSON.stringify({
          docker: {
            services: {
              backend: ["DATABASE_URL", "REDIS_URL"],
              frontend: ["PUBLIC_API_URL"],
            },
          },
        }),
      );

      const code = await dockerCommand(h.ctx, ["plan"]);
      const out = h.output();
      expect(out).toContain("EnvVault Docker Plan");
      expect(out).toContain("✓ DATABASE_URL");
      expect(out).toContain("✗ PUBLIC_API_URL");
      expect(out).not.toContain("db-secret");
      expect(out).not.toContain("redis-secret");
      expect(code).toBe(ExitCode.Missing);
    } finally {
      await h.cleanup();
    }
  });

  it("returns success when every required secret exists", async () => {
    const h = await createHarness();
    try {
      await setupProject(h, "crono", "dev", { DATABASE_URL: "db" });
      await writeProjectFile(
        h,
        ".envvault.json",
        JSON.stringify({ docker: { services: { backend: ["DATABASE_URL"] } } }),
      );
      expect(await dockerCommand(h.ctx, ["plan"])).toBe(ExitCode.Success);
    } finally {
      await h.cleanup();
    }
  });
});
