import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  LogcnValidationError,
  defineEvent,
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

describe("LogcnValidationError", () => {
  it("throws with path messages for nested zod failures", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const def = defineEvent(
      "auth.user.signed_up",
      z.object({
        user: z.object({ id: z.string() }),
      }),
    );

    try {
      logger.event(def).set({ user: { id: 1 } } as { user: { id: string } }).emit();
      expect.unreachable("emit should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(LogcnValidationError);
      const validation = error as LogcnValidationError;
      expect(validation.message).toMatch(/Event validation failed/);
      expect(validation.message).toMatch(/user\.id/);
      expect(validation.issues.some((issue) => issue.path.join(".") === "user.id")).toBe(
        true,
      );
    }

    expect(records).toHaveLength(0);
  });

  it("throws LogcnValidationError for Standard Schema issues", () => {
    const { sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const shape = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate(value: unknown) {
          const record = value as { code?: unknown };
          if (typeof record.code !== "string") {
            return {
              issues: [{ message: "Expected string", path: ["code"] }],
            };
          }
          return { value: record };
        },
      },
    };

    const def = defineEvent("standard.check", shape);

    expect(() => logger.event(def).set({ code: 1 } as { code: string }).emit()).toThrow(
      LogcnValidationError,
    );
  });
});
