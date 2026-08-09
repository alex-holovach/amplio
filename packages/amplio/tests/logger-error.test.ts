import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createError,
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
    expect(record?.error).toEqual({ message: "bad type", name: "TypeError" });
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

  it("structures createError plain objects with message, why, fix, and code", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const log = createLogger();
    log.error(
      {
        message: "payment declined",
        why: "insufficient funds",
        fix: "use another card",
        code: 402,
      },
      { status: 402 },
    );
    const record = log.emit();

    expect(record?.error).toEqual({
      message: "payment declined",
      why: "insufficient funds",
      fix: "use another card",
      code: "402",
    });
    expect(records).toHaveLength(1);
  });

  it("createError({...}) passed to error() preserves message instead of [object Object]", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = createLogger()
      .error(createError({ message: "structured", why: "because", fix: "retry", code: "E1" }))
      .emit();

    expect(record?.error).toEqual({
      message: "structured",
      why: "because",
      fix: "retry",
      code: "E1",
    });
    expect(records).toHaveLength(1);
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
    expect(record?.error).toEqual({ message: "signup failed", name: "Error" });
    expect(records).toHaveLength(1);
  });

  it("sets name without code for plain Error instances", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = createLogger().error(new Error("kaboom")).emit();

    expect(record?.error).toEqual({ message: "kaboom", name: "Error" });
    expect(record?.error).not.toHaveProperty("code");
    expect(records).toHaveLength(1);
  });

  it("sets code from err.code when present", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const err = new Error("missing file") as Error & { code: string };
    err.code = "ENOENT";

    const record = createLogger().error(err).emit();

    expect(record?.error).toEqual({
      message: "missing file",
      name: "Error",
      code: "ENOENT",
    });
    expect(records).toHaveLength(1);
  });

  it("stringifies numeric err.code", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const err = new Error("constraint failed") as Error & { code: number };
    err.code = 2002;

    const record = createLogger().error(err).emit();

    expect(record?.error).toEqual({
      message: "constraint failed",
      name: "Error",
      code: "2002",
    });
    expect(records).toHaveLength(1);
  });
});
