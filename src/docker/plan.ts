/**
 * `envvault docker plan` — a dry run that never reveals secret values.
 *
 * Useful locally and in CI: it exits non-zero when a configured service is
 * missing a required secret.
 */

import { symbols } from "../utils/output";
import { ExitCode } from "../utils/errors";
import type { DockerSettings } from "./config";

export interface DockerPlanService {
  name: string;
  present: string[];
  missing: string[];
}

export interface DockerPlanBuildSecret {
  name: string;
  present: boolean;
}

export interface DockerPlan {
  project: string;
  environment: string;
  services: DockerPlanService[];
  buildSecrets: DockerPlanBuildSecret[];
  availableCount: number;
  serviceCount: number;
}

export function buildDockerPlan(
  project: string,
  environment: string,
  settings: DockerSettings,
  resolved: Record<string, string>,
): DockerPlan {
  const available = new Set(Object.keys(resolved));

  const services: DockerPlanService[] = Object.entries(settings.services)
    .map(([name, names]) => {
      const present: string[] = [];
      const missing: string[] = [];
      for (const secret of names) {
        if (available.has(secret)) present.push(secret);
        else missing.push(secret);
      }
      return { name, present: present.sort(), missing: missing.sort() };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const buildSecrets: DockerPlanBuildSecret[] = settings.buildSecrets
    .map((name) => ({ name, present: available.has(name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    project,
    environment,
    services,
    buildSecrets,
    availableCount: available.size,
    serviceCount: services.length,
  };
}

export function formatDockerPlan(plan: DockerPlan): string {
  const lines: string[] = [];
  lines.push("EnvVault Docker Plan", "");
  lines.push("Project:", plan.project, "");
  lines.push("Environment:", plan.environment, "");

  if (plan.buildSecrets.length > 0) {
    lines.push("Build secrets:");
    for (const secret of plan.buildSecrets) {
      lines.push(`  ${secret.present ? symbols.check : symbols.cross} ${secret.name}`);
    }
    lines.push("");
  }

  if (plan.services.length === 0) {
    lines.push("No docker.services configured in .envvault.json.", "");
  } else {
    for (const service of plan.services) {
      lines.push(service.name);
      for (const name of service.present) lines.push(`  ${symbols.check} ${name}`);
      for (const name of service.missing) lines.push(`  ${symbols.cross} ${name}`);
      lines.push("");
    }
  }

  lines.push(`${plan.availableCount} secrets available`);
  lines.push(`${plan.serviceCount} services configured`, "");
  lines.push("No secret values displayed.");
  return lines.join("\n");
}

export function hasMissingPlanSecrets(plan: DockerPlan): boolean {
  return (
    plan.services.some((service) => service.missing.length > 0) ||
    plan.buildSecrets.some((secret) => !secret.present)
  );
}

export function dockerPlanExitCode(plan: DockerPlan): number {
  return hasMissingPlanSecrets(plan) ? ExitCode.Missing : ExitCode.Success;
}
