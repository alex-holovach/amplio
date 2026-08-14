import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createRequestLogger,
  defineEvent,
  init,
  logger,
  resetConfigForTests,
  type LogRecord,
  type Sink,
} from "../src/legacy.js";

beforeEach(() => {
  resetConfigForTests();
});

describe("request logger smoke", () => {
  it("createRequestLogger emits route context to a memory sink", () => {
    const records: LogRecord[] = [];
    const sink: Sink = (record) => {
      records.push(record);
    };

    init({ service: "smoke", env: "test", sinks: [sink] });

    const record = createRequestLogger({ method: "GET", path: "/health" })
      .set({ route: { name: "health" }, status: 200 })
      .emit();

    expect(records).toHaveLength(1);
    expect(records[0]).toBe(record);
    expect(record.service).toBe("smoke");
    expect(record.http).toEqual({ method: "GET", path: "/health" });
    expect(record.method).toBeUndefined();
    expect(record.path).toBeUndefined();
    expect(record.route).toEqual({ name: "health" });
    expect(record.status).toBe(200);
    expect(record.event).toBe("http.request");
    expect(record["@event"]).toBe("http.request");
  });

  it("domain events via logger.event keep their own event name", () => {
    const records: LogRecord[] = [];
    const sink: Sink = (record) => {
      records.push(record);
    };

    init({ service: "smoke", env: "test", sinks: [sink] });

    const def = defineEvent("auth.user.signed_up", z.object({ user: z.object({ id: z.string() }) }));

    const record = logger.event(def).set({ user: { id: "u1" } }).emit();

    expect(record?.event).toBe("auth.user.signed_up");
    expect(record?.["@event"]).toBe("auth.user.signed_up");
    expect(records).toHaveLength(1);
  });
});
