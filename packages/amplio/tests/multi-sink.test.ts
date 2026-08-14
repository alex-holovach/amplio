import { beforeEach, describe, expect, it } from "vitest";
import { createLogger, init, resetConfigForTests, type LogRecord, type Sink } from "../src/legacy.js";

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
});

describe("multi-sink", () => {
  it("one emit delivers the same record to both memory sinks", () => {
    const first = memorySink();
    const second = memorySink();
    init({ service: "api", env: "test", sinks: [first.sink, second.sink] });

    const record = createLogger().set({ route: "/health" }).emit();

    expect(first.records).toHaveLength(1);
    expect(second.records).toHaveLength(1);
    expect(first.records[0]).toBe(record);
    expect(second.records[0]).toBe(record);
    expect(first.records[0]).toBe(second.records[0]);
    expect(record.route).toBe("/health");
  });

  it("one emit delivers the same record to three memory sinks", () => {
    const first = memorySink();
    const second = memorySink();
    const third = memorySink();
    init({ service: "api", env: "test", sinks: [first.sink, second.sink, third.sink] });

    const record = createLogger().set({ route: "/health" }).emit();

    expect(first.records).toHaveLength(1);
    expect(second.records).toHaveLength(1);
    expect(third.records).toHaveLength(1);
    expect(first.records[0]).toBe(record);
    expect(second.records[0]).toBe(record);
    expect(third.records[0]).toBe(record);
    expect(first.records[0]).toBe(second.records[0]);
    expect(second.records[0]).toBe(third.records[0]);
    expect(record.route).toBe("/health");
  });
});
