import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createLogger,
  defineEvent,
  init,
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

describe("logger.error", () => {
  it("structures Error instances, merges ctx, and sets success false", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const log = createLogger();
    log.error(new TypeError("bad type"), { status: 500 });
    const record = log.emit();

    expect(record?.success).toBe(false);
    expect(record?.status).toBe(500);
    expect(record?.error).toEqual({ message: "bad type", code: "TypeError" });
    expect(records).toHaveLength(1);
  });

  it("stringifies non-Error values", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const log = createLogger();
    log.error("something failed");
    const record = log.emit();

    expect(record?.success).toBe(false);
    expect(record?.error).toEqual({ message: "something failed" });
    expect(records).toHaveLength(1);
  });

  it("does not auto-emit", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const log = createLogger();
    log.error(new Error("x"));

    expect(records).toHaveLength(0);
    expect(log.sealed).toBe(false);
  });

  it("returns the same logger instance for chaining", () => {
    init({ service: "api", env: "test", sinks: [() => {}] });
    const log = createLogger();
    expect(log.error(new Error("x"))).toBe(log);
  });
});

describe("EventLogger.error", () => {
  it("delegates to bound logger and preserves chaining", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const def = defineEvent(
      "auth.user.signed_up",
      z.object({ user: z.object({ id: z.string() }).optional() }),
    );

    const event = createLogger()
      .event(def)
      .error(new Error("signup failed"), { status: 500 });
    const record = event.emit();

    expect(record?.success).toBe(false);
    expect(record?.status).toBe(500);
    expect(record?.error).toEqual({ message: "signup failed", code: "Error" });
    expect(records).toHaveLength(1);
  });
});
