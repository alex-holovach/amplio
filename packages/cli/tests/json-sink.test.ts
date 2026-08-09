import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LogRecord } from "@useamplio/core";
import { afterEach, describe, expect, it } from "vitest";
import { jsonFileSink } from "../../../registry/sinks/json.ts";

describe("jsonFileSink", () => {
  const prevEnv = process.env.AMPLIO_JSON_SINK_PATH;
  const prevCwd = process.cwd();
  let root: string;

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevEnv === undefined) {
      delete process.env.AMPLIO_JSON_SINK_PATH;
    } else {
      process.env.AMPLIO_JSON_SINK_PATH = prevEnv;
    }
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates nested parent dirs and appends a JSON line", () => {
    root = mkdtempSync(path.join(tmpdir(), "amplio-json-sink-"));
    const filePath = path.join(root, "subdir", "nested", "out.jsonl");
    const sink = jsonFileSink({ path: filePath });
    const record: LogRecord = { event: "test.nested", service: "json-sink" };

    sink(record);

    expect(readFileSync(filePath, "utf8")).toBe(`${JSON.stringify(record)}\n`);
  });

  it("two sequential writes to same path append two JSONL lines", () => {
    root = mkdtempSync(path.join(tmpdir(), "amplio-json-sink-"));
    const filePath = path.join(root, "append.jsonl");
    const sink = jsonFileSink({ path: filePath });
    const first: LogRecord = { event: "test.append.first", service: "json-sink" };
    const second: LogRecord = { event: "test.append.second", service: "json-sink" };

    sink(first);
    sink(second);

    expect(readFileSync(filePath, "utf8")).toBe(
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
    );
  });

  it("uses AMPLIO_JSON_SINK_PATH when options.path is omitted", () => {
    root = mkdtempSync(path.join(tmpdir(), "amplio-json-sink-"));
    const filePath = path.join(root, "env", "nested", "from-env.jsonl");

    try {
      process.env.AMPLIO_JSON_SINK_PATH = filePath;
      const sink = jsonFileSink();
      const record: LogRecord = { event: "test.env", service: "json-sink" };

      sink(record);

      expect(readFileSync(filePath, "utf8")).toBe(`${JSON.stringify(record)}\n`);
    } finally {
      if (prevEnv === undefined) {
        delete process.env.AMPLIO_JSON_SINK_PATH;
      } else {
        process.env.AMPLIO_JSON_SINK_PATH = prevEnv;
      }
    }
  });
  it("options.path wins over AMPLIO_JSON_SINK_PATH when both are set", () => {
    root = mkdtempSync(path.join(tmpdir(), "amplio-json-sink-"));
    const optionsPath = path.join(root, "opts", "from-options.jsonl");
    const envPath = path.join(root, "env", "from-env.jsonl");
    process.env.AMPLIO_JSON_SINK_PATH = envPath;
    const sink = jsonFileSink({ path: optionsPath });
    const record: LogRecord = { event: "test.precedence", service: "json-sink" };

    sink(record);

    expect(readFileSync(optionsPath, "utf8")).toBe(`${JSON.stringify(record)}\n`);
    expect(existsSync(envPath)).toBe(false);
  });

  it("defaults to amplio.jsonl in cwd when path and env are unset", () => {
    root = mkdtempSync(path.join(tmpdir(), "amplio-json-sink-"));
    delete process.env.AMPLIO_JSON_SINK_PATH;
    process.chdir(root);
    const sink = jsonFileSink();
    const record: LogRecord = { event: "test.cwd-default", service: "json-sink" };

    sink(record);

    const filePath = path.join(root, "amplio.jsonl");
    expect(readFileSync(filePath, "utf8")).toBe(`${JSON.stringify(record)}\n`);
  });
  it("defaults to amplio.jsonl in cwd when AMPLIO_JSON_SINK_PATH is empty", () => {
    root = mkdtempSync(path.join(tmpdir(), "amplio-json-sink-"));
    process.env.AMPLIO_JSON_SINK_PATH = "";
    process.chdir(root);
    const sink = jsonFileSink();
    const record: LogRecord = { event: "test.cwd-empty-env", service: "json-sink" };

    sink(record);

    const filePath = path.join(root, "amplio.jsonl");
    expect(readFileSync(filePath, "utf8")).toBe(`${JSON.stringify(record)}\n`);
  });
  it("defaults to amplio.jsonl in cwd when AMPLIO_JSON_SINK_PATH is whitespace-only", () => {
    root = mkdtempSync(path.join(tmpdir(), "amplio-json-sink-"));
    process.env.AMPLIO_JSON_SINK_PATH = "   ";
    process.chdir(root);
    const sink = jsonFileSink();
    const record: LogRecord = { event: "test.cwd-whitespace-env", service: "json-sink" };

    sink(record);

    const filePath = path.join(root, "amplio.jsonl");
    expect(readFileSync(filePath, "utf8")).toBe(`${JSON.stringify(record)}\n`);
  });

});
