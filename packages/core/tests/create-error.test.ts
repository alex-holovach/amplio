import { beforeEach, describe, expect, it } from "vitest";
import {
  createError,
  init,
  logger,
  resetConfigForTests,
  type LogRecord,
  type Sink,
} from "../src/index.js";

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

describe("createError", () => {
  it("includes message, why, fix, code, link", () => {
    const err = createError({
      message: "Invalid token",
      why: "Token expired",
      fix: "Refresh session",
      code: "AUTH_EXPIRED",
      link: "https://docs.example/auth",
    });

    expect(err).toEqual({
      message: "Invalid token",
      why: "Token expired",
      fix: "Refresh session",
      code: "AUTH_EXPIRED",
      link: "https://docs.example/auth",
    });
  });

  it("returns only message when optionals are omitted", () => {
    const result = createError({ message: "boom" });

    expect(result).toEqual({ message: "boom" });
    expect(result).not.toHaveProperty("why");
    expect(result).not.toHaveProperty("fix");
    expect(result).not.toHaveProperty("code");
    expect(result).not.toHaveProperty("link");
  });

  it("logger.create().set({ error: createError(...) }).emit() puts structured error on the record via memory sink", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const structuredError = createError({
      message: "Payment failed",
      why: "Card declined",
      fix: "Use another card",
      code: "PAYMENT_DECLINED",
      link: "https://docs.example/payments",
    });

    const record = logger.create().set({ error: structuredError }).emit();

    expect(records).toHaveLength(1);
    expect(records[0]).toBe(record);
    expect(record.error).toEqual(structuredError);
  });

  it("ignores set() after emit (soft seal)", () => {
    const { sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const scope = logger.create().set({
      error: createError({ message: "Something broke" }),
    });

    scope.emit();

    expect(scope.sealed).toBe(true);
    expect(scope.set({ x: 1 })).toBe(scope);
    expect(scope.emit()).toBeNull();
  });
});
