import { beforeEach, describe, expect, it } from "vitest";
import { createLogger, init, resetConfigForTests, type LogRecord, type Sink } from "../src/legacy.js";

beforeEach(() => {
  resetConfigForTests();
});

describe("emit() return value reflects delivery", () => {
  const memorySink = (): { records: LogRecord[]; sink: Sink } => {
    const records: LogRecord[] = [];
    return {
      records,
      sink: (record) => {
        records.push(record);
      },
    };
  };

  it("rate 0 with no keep rules: emit() returns null and sinks receive nothing", () => {
    const { records, sink } = memorySink();
    init({ service: "api", env: "test", sinks: [sink], sampling: { rate: 0 } });

    const record = createLogger().set({ step: "x" }).emit();

    expect(record).toBeNull();
    expect(records).toHaveLength(0);
  });

  it("rate 0 with matching keep rule: emit() returns record and sink receives it", () => {
    const { records, sink } = memorySink();
    init({
      service: "api",
      env: "test",
      sinks: [sink],
      sampling: { rate: 0, keep: [{ field: "severity", equals: "ERROR" }] },
    });

    const record = createLogger().set({ severity: "ERROR", step: "y" }).emit();

    expect(record).not.toBeNull();
    expect(record?.severity).toBe("ERROR");
    expect(record?.step).toBe("y");
    expect(records).toHaveLength(1);
    expect(records[0]?.severity).toBe("ERROR");
  });
});
