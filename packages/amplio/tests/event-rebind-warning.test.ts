import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createRequestLogger,
  defineEvent,
  getLogger,
  init,
  resetConfigForTests,
  runWithLogger,
  type LogRecord,
  type Sink,
} from "../src/index.js";

const REBIND_NOTICE =
  '[amplio] .event("auth.user.signed_up") on a logger already bound to "http.request" now emits a separate correlated row and keeps the "http.request" spine (same as .child()). Spell it .child(EventDef) to make the intent explicit.';

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

describe(".event() on an already-named spine", () => {
  it("behaves as .child(): separate correlated row, spine stays unsealed, dev notice", () => {
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
      getLogger()
        .event(def)
        .set({ user: { id: "u_1" } })
        .emit();
    });

    expect(warn).toHaveBeenCalledWith(REBIND_NOTICE);
    // The spine is preserved — the request row can still be emitted.
    expect(requestLogger.sealed).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0]!.event).toBe("auth.user.signed_up");
    expect(records[0]!.request_id).toBe("req_rebind");
    // Domain row, not a mutated spine: no http.* fields copied over.
    expect(records[0]!.http).toBeUndefined();

    requestLogger.set({ status: 200 }).emit();
    expect(records).toHaveLength(2);
    expect(records[1]!.event).toBe("http.request");
    expect(records[1]!.request_id).toBe("req_rebind");

    warn.mockRestore();
  });

  it("same-name .event() still binds the schema onto the spine (no notice)", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const httpRequest = defineEvent("http.request");
    const requestLogger = createRequestLogger({
      method: "GET",
      path: "/health",
      requestId: "req_same",
    });

    requestLogger.event(httpRequest).emit();

    expect(warn).not.toHaveBeenCalled();
    expect(records).toHaveLength(1);
    expect(records[0]!.event).toBe("http.request");
    // Same seal: the spine is consumed by this emit.
    expect(requestLogger.sealed).toBe(true);

    warn.mockRestore();
  });
});
