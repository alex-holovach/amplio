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

describe("redact: false", () => {
  it("does not redact when redact is disabled", () => {
    const { records, sink } = memorySink();
    init({ service: "api", env: "test", redact: false, sinks: [sink] });

    createLogger().set({ user: { email: "user@example.com", id: "u1" } }).emit();

    expect(records[0].user).toEqual({ email: "user@example.com", id: "u1" });
  });
});
