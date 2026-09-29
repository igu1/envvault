import { resolveSecretDetails } from "../core/resolver";
import { resolveContextOrThrow } from "../core/scope";
import { openVault } from "../core/unlock";
import { assertEnvironment } from "../core/vault";
import { readEnvExampleNames, scanProject } from "../env/scanner";
import type { EnvReference } from "../env/scanner";
import type { AppContext } from "../core/types";
import { ExitCode } from "../utils/errors";
import { flagBool, flagString } from "../utils/args";
import type { ParsedArgs } from "../utils/args";
import { symbols } from "../utils/output";

const MAX_REFERENCE_LINES = 5;

export async function doctorCommand(ctx: AppContext, args: ParsedArgs): Promise<number> {
  const { vault } = await openVault(ctx);
  const context = await resolveContextOrThrow(ctx, {
    project: flagString(args.flags, "project"),
    environment: flagString(args.flags, "env"),
  });
  assertEnvironment(vault, context.project, context.environment);

  const details = resolveSecretDetails(vault, context);
  const available = new Set(details.map((secret) => secret.name));

  const references = await scanProject(ctx.cwd);
  const exampleNames = await readEnvExampleNames(ctx.cwd);

  const byName = new Map<string, EnvReference[]>();
  const referencedNames = new Set<string>();
  for (const reference of references) {
    referencedNames.add(reference.name);
    const list = byName.get(reference.name) ?? [];
    list.push(reference);
    byName.set(reference.name, list);
  }
  for (const name of exampleNames) referencedNames.add(name);

  const missing = [...referencedNames].filter((name) => !available.has(name)).sort();
  const unused = [...available].filter((name) => !referencedNames.has(name)).sort();

  const io = ctx.io;
  io.stdout("EnvVault Doctor");
  io.stdout("");
  io.stdout("Project:");
  io.stdout(`${context.project} / ${context.environment}`);
  io.stdout("");

  for (const secret of details) io.stdout(`${symbols.check} ${secret.name}`);
  if (details.length > 0 && (missing.length > 0 || unused.length > 0)) io.stdout("");

  for (const name of missing) {
    io.stdout(`${symbols.cross} ${name}`);
    const refs = byName.get(name) ?? [];
    if (refs.length > 0) {
      io.stdout("  referenced in:");
      for (const ref of refs.slice(0, MAX_REFERENCE_LINES)) {
        io.stdout(`  ${ref.file}:${ref.line}`);
      }
    } else if (exampleNames.includes(name)) {
      io.stdout("  listed in .env.example");
    }
    io.stdout("  but missing from EnvVault");
    io.stdout("");
  }

  for (const name of unused) {
    io.stdout(`${symbols.warn} ${name}`);
    io.stdout("  exists in EnvVault");
    io.stdout("  but was not found in project source");
    io.stdout("");
  }

  if (missing.length === 0 && unused.length === 0) {
    io.stdout("Environment configuration looks healthy.");
  } else {
    io.stdout(`${missing.length} missing`);
    io.stdout(`${unused.length} possibly unused`);
  }

  const strict = flagBool(args.flags, "strict");
  return strict && missing.length > 0 ? ExitCode.Missing : ExitCode.Success;
}
