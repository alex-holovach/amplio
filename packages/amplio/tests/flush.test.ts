import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  flush,
  init,
  resetConfigForTests,
  type LogRecord,
  type Sink,
} from "../src/index.js";

beforeEach(() => {
  resetConfigForTests();
});

describe("flush", () => {
  it("awaits a slow async sink before returning", async () => {
    const records: LogRecord[] = [];
    let resolveSink: (() => void) | undefined;
    const sink: Sink = () =>
      new Promise<void>((resolve) => {
        resolveSink = resolve;
      }).then(() => {
        records.push({ service: "api", env: "test", timestamp: "", duration_ms: 0, ok: true });
      });

    init({ service: "api", env: "test", sinks: [sink] });
    createLogger().set({ ok: true }).emit();

    expect(records).toHaveLength(0);

    resolveSink?.();
    await flush();

    expect(records).toHaveLength(1);
  });

  it("clears pending after flush completes", async () => {
    const records: LogRecord[] = [];
    const sink: Sink = async (record) => {
      records.push(record);
    };
    init({ service: "api", env: "test", sinks: [sink] });

    createLogger().set({ route: "/health" }).emit();
    await flush();
    await flush();

    expect(records).toHaveLength(1);
  });

  it("warns in development when an async sink rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sink: Sink = async () => {
      throw new Error("sink failed");
    };
    init({ service: "api", env: "test", sinks: [sink] });

    createLogger().emit();
    await flush();

    expect(warn).toHaveBeenCalledWith("[amplio] async sink failed: sink failed");
    warn.mockRestore();
  });
});
