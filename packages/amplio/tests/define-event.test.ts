import { beforeEach, describe, expect, it } from "vitest";
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

beforeEach(() => {
  resetConfigForTests();
});

describe("defineEvent", () => {
  it("logger.event(def).set({ user: { id: 'u1' } }).emit() succeeds via memory sink", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = logger.event(signedUpDef).set({ user: { id: "u1" } }).emit();

    expect(records).toHaveLength(1);
    expect(records[0]).toBe(record);
    expect(record.event).toBe("auth.user.signed_up");
    expect(record.user).toEqual({ id: "u1" });
  });

  it("emit fails validation when user.id is not a string", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    expect(() =>
      logger
        .event(signedUpDef)
        .set({ user: { id: 1 } } as { user: { id: string } })
        .emit(),
    ).toThrow(/Event validation failed/);

    expect(records).toHaveLength(0);
  });

  it("emit fails validation when required shape is missing", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    expect(() => logger.event(signedUpDef).emit()).toThrow(/Event validation failed/);

    expect(records).toHaveLength(0);
  });
});
