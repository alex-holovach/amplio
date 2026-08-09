import { beforeEach, describe, expect, it } from "vitest";
import { createLogger, init, resetConfigForTests } from "../src/index.js";
import type { LogRecord, Sink } from "../src/index.js";

const capture = (): { records: LogRecord[]; sink: Sink } => {
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

describe("PII redaction on emit (default redact)", () => {
  it("redacts credit card-like number in string field", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    createLogger()
      .set({ note: "charged card 4111111111111111 for order" })
      .emit();

    expect(records[0]?.note).toBe("charged card [REDACTED] for order");
    expect(records[0]?.note).not.toContain("4111111111111111");
  });

  it("redacts JWT-like string in string field", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    createLogger()
      .set({ note: `session token ${jwt} expired` })
      .emit();

    expect(records[0]?.note).not.toContain("eyJ");
    expect(records[0]?.note).toContain("[REDACTED]");
  });

  it("redacts field named password", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    createLogger()
      .set({ password: "super-secret-password" })
      .emit();

    expect(records[0]?.password).toBe("[REDACTED]");
    expect(records[0]?.password).not.toContain("super-secret");
  });
});
