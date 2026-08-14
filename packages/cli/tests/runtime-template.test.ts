import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  renderConsoleSinkTemplate,
  renderRuntimeTemplate,
} from "../src/templates/init.js";
import type { Sink, SinkRecord } from "@useamplio/amplio";

describe("runtime init template", () => {
  it("imports the generated console sink into the runtime", () => {
    const source = renderRuntimeTemplate("template-test");

    expect(source).toContain(
      'import { consoleSink } from "./sinks/console.js"',
    );
    expect(source).toContain("sinks: [consoleSink]");
    expect(source).not.toContain("JSON.stringify");
  });

  it("executes the generated console sink for BigInt and cyclic records", () => {
    const source = renderConsoleSinkTemplate()
      .replace(/^import .*;\n/gm, "")
      .replace("export const consoleSink: Sink =", "globalThis.consoleSink =");
    const executable = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.None,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const lines: string[] = [];
    const context = {
      console: {
        log(line: string) {
          lines.push(line);
        },
      },
      consoleSink: undefined as Sink | undefined,
    };
    vm.runInNewContext(executable, context);
    const record = {
      "@event": "template.unsafe_values",
      count: 9_007_199_254_740_993n,
    } as unknown as SinkRecord & { self?: unknown };
    record.self = record;

    expect(() => context.consoleSink!(record)).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      "@event": "template.unsafe_values",
      count: "9007199254740993",
      self: "[Circular]",
    });
  });

  it("stays byte-for-byte identical to the registry console sink", () => {
    const registrySource = readFileSync(
      path.resolve(import.meta.dirname, "../../../registry/sinks/console.ts"),
      "utf8",
    );

    expect(renderConsoleSinkTemplate()).toBe(registrySource);
  });
});
