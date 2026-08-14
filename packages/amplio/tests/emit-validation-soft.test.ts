import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineEvent,
  init,
  logger,
  resetConfigForTests,
  type LogRecord,
  type Sink,
} from "../src/legacy.js";

const capture = (): { records: LogRecord[]; sink: Sink } => {
  const records: LogRecord[] = [];
  return {
    records,
    sink: (record) => {
      records.push(record);
    },
  };
};

const signedUpDef = defineEvent(
  "auth.user.signed_up",
  z.object({ user: z.object({ id: z.string() }) }),
);

const originalNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  resetConfigForTests();
});

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  vi.restoreAllMocks();
});

describe("emit validation soft-fail", () => {
  it("soft-fails in production: emits record with validation issues, does not throw", () => {
    process.env.NODE_ENV = "production";
    const { records, sink } = capture();
    init({ service: "api", env: "prod", sinks: [sink] });

    const record = logger.event(signedUpDef).emit();

    expect(record).not.toBeNull();
    expect(record?.success).toBe(false);
    expect(record?.validation).toEqual({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ message: expect.any(String) }),
      ]),
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toBe(record);
  });

  it("throws in production when init({ strict: true })", () => {
    process.env.NODE_ENV = "production";
    const { records, sink } = capture();
    init({ service: "api", env: "prod", sinks: [sink], strict: true });

    expect(() => logger.event(signedUpDef).emit()).toThrow(/Event validation failed/);
    expect(records).toHaveLength(0);
  });

  it("still throws under NODE_ENV=test (vitest default)", () => {
    process.env.NODE_ENV = "test";
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    expect(() => logger.event(signedUpDef).emit()).toThrow(/Event validation failed/);
    expect(records).toHaveLength(0);
  });
});
