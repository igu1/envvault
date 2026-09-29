import { describe, expect, it } from "vitest";

import { isValidEnvKey, parseEnv } from "../src/env/parser";

describe("env/parseEnv", () => {
  it("parses simple assignments", () => {
    expect(parseEnv("KEY=value")).toEqual([{ key: "KEY", value: "value" }]);
  });

  it("parses multiple lines and skips blanks/comments", () => {
    const content = ["# comment", "", "A=1", "  # indented comment", "B=2", ""].join("\n");
    expect(parseEnv(content)).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "2" },
    ]);
  });

  it("strips an `export ` prefix", () => {
    expect(parseEnv("export TOKEN=abc")).toEqual([{ key: "TOKEN", value: "abc" }]);
  });

  it("handles double-quoted values and escapes", () => {
    expect(parseEnv('MSG="hello world"')).toEqual([{ key: "MSG", value: "hello world" }]);
    expect(parseEnv('MSG="line1\\nline2"')).toEqual([{ key: "MSG", value: "line1\nline2" }]);
    expect(parseEnv('MSG="say \\"hi\\""')).toEqual([{ key: "MSG", value: 'say "hi"' }]);
  });

  it("keeps single-quoted values literal", () => {
    expect(parseEnv("RAW='$NOT_EXPANDED \\n'")).toEqual([
      { key: "RAW", value: "$NOT_EXPANDED \\n" },
    ]);
  });

  it("preserves equals signs inside values", () => {
    expect(parseEnv("URL=postgres://u:p@h/db?a=1&b=2")).toEqual([
      { key: "URL", value: "postgres://u:p@h/db?a=1&b=2" },
    ]);
    expect(parseEnv('EQ="a=b=c"')).toEqual([{ key: "EQ", value: "a=b=c" }]);
  });

  it("supports empty values", () => {
    expect(parseEnv("EMPTY=")).toEqual([{ key: "EMPTY", value: "" }]);
    expect(parseEnv('EMPTY=""')).toEqual([{ key: "EMPTY", value: "" }]);
  });

  it("strips inline comments only when preceded by whitespace", () => {
    expect(parseEnv("A=value # a comment")).toEqual([{ key: "A", value: "value" }]);
    expect(parseEnv("B=value#not-a-comment")).toEqual([{ key: "B", value: "value#not-a-comment" }]);
    expect(parseEnv('C="value # kept"')).toEqual([{ key: "C", value: "value # kept" }]);
  });

  it("ignores lines without an assignment or with invalid keys", () => {
    expect(parseEnv("NOT_AN_ASSIGNMENT\n1BAD=x\n=x")).toEqual([]);
  });

  it("does not evaluate shell expressions", () => {
    expect(parseEnv("CMD=$(rm -rf /)")).toEqual([{ key: "CMD", value: "$(rm -rf /)" }]);
    expect(parseEnv("CMD=`whoami`")).toEqual([{ key: "CMD", value: "`whoami`" }]);
  });

  it("validates key names", () => {
    expect(isValidEnvKey("GOOD_NAME")).toBe(true);
    expect(isValidEnvKey("_also9")).toBe(true);
    expect(isValidEnvKey("9bad")).toBe(false);
    expect(isValidEnvKey("has-dash")).toBe(false);
    expect(isValidEnvKey("has space")).toBe(false);
  });
});
