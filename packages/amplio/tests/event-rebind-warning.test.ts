import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createRequestLogger,
  defineEvent,
  init,
  resetConfigForTests,
  runWithLogger,
  useLogger,
  type LogRecord,
  type Sink,
} from "../src/index.js";

const REBIND_WARNING =
  '[amplio] emitting .event("auth.user.signed_up") from a logger already bound to "http.request" rebinds and seals it — no separate "http.request" row will be emitted for this request. For a separate correlated domain event, use .child(EventDef) instead.';

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

describe("event rebind dev warning", () => {
  it("useLogger().event(def).emit() warns and seals the request spine", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const requestLogger = createRequestLogger({
      method: "POST",
      path: "/signup",
      requestId: "req_rebind",
    });

    const def = defineEvent(
      "auth.user.signed_up",
      z.object({ user: z.object({ id: z.string() }) }),
    );

    runWithLogger(requestLogger, () => {
      useLogger()
        .event(def)
        .set({ user: { id: "u_1" } })
        .emit();
    });

    expect(warn).toHaveBeenCalledWith(REBIND_WARNING);
    expect(requestLogger.sealed).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0].event).toBe("auth.user.signed_up");
    expect(records[0].request_id).toBe("req_rebind");

    warn.mockRestore();
  });
});
