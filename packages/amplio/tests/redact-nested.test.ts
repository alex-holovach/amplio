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

describe("nested redaction on emit", () => {
  it("redacts nested user.email in emitted record", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    createLogger()
      .set({ user: { email: "user@example.com", id: "u1" } })
      .emit();

    expect(records[0]?.user).toEqual({ email: "[REDACTED]", id: "u1" });
  });

  it("redacts nested authorization and bearer tokens", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    createLogger()
      .set({
        headers: {
          authorization: "Bearer secret-token",
          "x-forwarded-for": "1.2.3.4",
        },
        note: "Authorization: Bearer inline-token",
      })
      .emit();

    expect(records[0]?.headers).toEqual({
      authorization: "[REDACTED]",
      "x-forwarded-for": "1.2.3.4",
    });
    expect(records[0]?.note).toBe("[REDACTED]");
    expect(records[0]?.note).not.toContain("inline-token");
  });

  it("redacts emails in deeply nested objects", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    createLogger()
      .set({
        payload: {
          level1: {
            level2: {
              contact: "reach me at deep@example.com please",
              email: "nested@example.com",
            },
          },
        },
      })
      .emit();

    const nested = records[0]?.payload as {
      level1: { level2: { contact: string; email: string } };
    };
    expect(nested.level1.level2.contact).toBe("reach me at [REDACTED] please");
    expect(nested.level1.level2.email).toBe("[REDACTED]");
  });
});
