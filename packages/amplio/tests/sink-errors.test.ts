import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  init,
  resetConfigForTests,
  type LogRecord,
  type Sink,
} from "../src/legacy.js";

const memorySink = (): { records: LogRecord[]; sink: Sink } => {
  const records: LogRecord[] = [];
  return {
    records,
    sink: (record) => {
      records.push(record);
    },
  };
};

beforeEach(() => {
  resetConfigForTests();
  vi.restoreAllMocks();
});

describe("sink errors", () => {
  it("first sync sink throws, second memory sink still receives record", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const second = memorySink();
    const failure = new Error("sink failed");
    const failingSink: Sink = () => {
      throw failure;
    };
    init({ service: "api", env: "test", sinks: [failingSink, second.sink] });

    const record = createLogger().set({ route: "/health" }).emit();

    expect(second.records).toHaveLength(1);
    expect(second.records[0]).toBe(record);
    expect(record.route).toBe("/health");
    expect(warn).toHaveBeenCalledWith("[amplio] sink_failed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(failure.message);
  });

  it("first sink throws, second throws, third memory sink still receives record", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const third = memorySink();
    const firstFailing: Sink = () => {
      throw new Error("first sink failed");
    };
    const secondFailing: Sink = () => {
      throw new Error("second sink failed");
    };
    init({
      service: "api",
      env: "test",
      sinks: [firstFailing, secondFailing, third.sink],
    });

    const record = createLogger().set({ route: "/health" }).emit();

    expect(third.records).toHaveLength(1);
    expect(third.records[0]).toBe(record);
    expect(record.route).toBe("/health");
  });

  it("sync sink throws — emit() does not throw", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failingSink: Sink = () => {
      throw new Error("sink failed");
    };
    init({ service: "api", env: "test", sinks: [failingSink] });

    expect(() => createLogger().set({ route: "/health" }).emit()).not.toThrow();
  });
});
