import { beforeEach, describe, expect, it } from "vitest";
import {
  createLogger,
  init,
  redactRecord,
  resetConfigForTests,
} from "../src/legacy.js";
import type { LogRecord, Sink } from "../src/legacy.js";

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

  it("replaces object and array back-edges without mutating the input", () => {
    const payload: Record<string, unknown> = {
      email: "cycle@example.com",
    };
    const items: unknown[] = [];
    payload.self = payload;
    payload.items = items;
    items.push(items);

    const redacted = redactRecord(payload as LogRecord);

    expect(redacted).not.toBe(payload);
    expect(redacted.email).toBe("[REDACTED]");
    expect(redacted.self).toBe("[Circular]");
    expect(redacted.items).toEqual(["[Circular]"]);
    expect(payload.self).toBe(payload);
    expect(items[0]).toBe(items);
    expect(() => JSON.stringify(redacted)).not.toThrow();
  });

  it("does not mistake repeated non-cyclic references for back-edges", () => {
    const shared = { email: "shared@example.com" };
    const redacted = redactRecord({
      first: shared,
      second: shared,
    } as LogRecord);

    expect(redacted).toEqual({
      first: { email: "[REDACTED]" },
      second: { email: "[REDACTED]" },
    });
  });

  it("emits a JSON-safe record when application data is cyclic", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });
    const payload: Record<string, unknown> = { id: "cyclic" };
    payload.self = payload;

    expect(() => createLogger().set({ payload }).emit()).not.toThrow();

    expect(records).toHaveLength(1);
    expect(records[0]?.payload).toEqual({ id: "cyclic", self: "[Circular]" });
    expect(() => JSON.stringify(records[0])).not.toThrow();
  });
});
