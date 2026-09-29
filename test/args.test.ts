import { describe, expect, it } from "vitest";

import { flagBool, flagList, extractOptions, parseArgs, parseLeadingOptions } from "../src/utils/args";
import { UsageError } from "../src/utils/errors";

describe("args/parseArgs", () => {
  it("collects positionals and values", () => {
    const parsed = parseArgs(["crono", "--env", "dev"], ["global"]);
    expect(parsed.positionals).toEqual(["crono"]);
    expect(parsed.flags.env).toBe("dev");
  });

  it("supports --flag=value", () => {
    const parsed = parseArgs(["--env=production"]);
    expect(parsed.flags.env).toBe("production");
  });

  it("treats declared booleans as booleans", () => {
    const parsed = parseArgs(["--global", "NAME"], ["global"]);
    expect(parsed.flags.global).toBe(true);
    expect(parsed.positionals).toEqual(["NAME"]);
  });

  it("supports --no-<flag>", () => {
    const parsed = parseArgs(["--no-clear"], ["clear"]);
    expect(parsed.flags.clear).toBe(false);
    expect(flagBool(parsed.flags, "clear")).toBe(false);
  });

  it("captures everything after --", () => {
    const parsed = parseArgs(["run", "--", "npm", "run", "dev"]);
    expect(parsed.positionals).toEqual(["run"]);
    expect(parsed.rest).toEqual(["npm", "run", "dev"]);
  });

  it("parses comma-separated lists", () => {
    const parsed = parseArgs(["--only", "A,B , C"]);
    expect(flagList(parsed.flags, "only")).toEqual(["A", "B", "C"]);
  });
});

describe("args/parseLeadingOptions", () => {
  const spec = { service: "value", only: "value", quiet: "boolean" } as const;

  it("consumes leading flags and leaves child args untouched", () => {
    const result = parseLeadingOptions(
      ["--service", "backend", "--rm", "-p", "8000:8000", "my-image"],
      spec,
    );
    expect(result.options.service).toBe("backend");
    expect(result.rest).toEqual(["--rm", "-p", "8000:8000", "my-image"]);
  });

  it("stops at the first unknown token", () => {
    const result = parseLeadingOptions(["up", "-d"], spec);
    expect(result.options).toEqual({});
    expect(result.rest).toEqual(["up", "-d"]);
  });

  it("honours an explicit -- terminator", () => {
    const result = parseLeadingOptions(["--quiet", "--", "--rm", "image"], spec);
    expect(result.options.quiet).toBe(true);
    expect(result.usedTerminator).toBe(true);
    expect(result.rest).toEqual(["--rm", "image"]);
  });

  it("does not swallow docker's own --env flag", () => {
    const result = parseLeadingOptions(["--env", "FOO=bar", "image"], spec);
    expect(result.rest).toEqual(["--env", "FOO=bar", "image"]);
  });

  it("throws are not swallowed: unknown flags pass through", () => {
    const result = parseLeadingOptions(["--mode", "secret", "up"], { mode: "value" });
    expect(result.options.mode).toBe("secret");
    expect(result.rest).toEqual(["up"]);
  });
});

describe("args/extractOptions", () => {
  const spec = { only: "value", service: "value" } as const;

  it("removes known flags from anywhere while preserving order", () => {
    const { options, rest } = extractOptions(
      ["--rm", "-p", "8000:8000", "--only", "A,B", "image"],
      spec,
    );
    expect(options.only).toBe("A,B");
    expect(rest).toEqual(["--rm", "-p", "8000:8000", "image"]);
  });

  it("leaves Docker's own flags untouched", () => {
    const { options, rest } = extractOptions(["--env", "FOO=bar", "--rm", "image"], spec);
    expect(options).toEqual({});
    expect(rest).toEqual(["--env", "FOO=bar", "--rm", "image"]);
  });

  it("supports --flag=value", () => {
    const { options, rest } = extractOptions(["--only=A,B", "image"], spec);
    expect(options.only).toBe("A,B");
    expect(rest).toEqual(["image"]);
  });

  it("stops extracting after a literal -- so it can act as an escape hatch", () => {
    const { options, rest } = extractOptions(["--", "--only", "A"], spec);
    expect(options.only).toBeUndefined();
    expect(rest).toEqual(["--", "--only", "A"]);
  });
});

describe("args/UsageError", () => {
  it("carries the usage exit code", () => {
    expect(new UsageError("bad").exitCode).toBe(2);
  });
});
