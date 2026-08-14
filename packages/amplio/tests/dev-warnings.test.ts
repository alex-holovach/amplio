import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  createRequestLogger,
  hasAmbientLogger,
  init,
  resetConfigForTests,
  resetEmitBeforeInitWarningForTests,
  resetUseLoggerDeprecationWarningForTests,
  resetUseLoggerOutsideScopeWarningForTests,
  runWithLogger,
  useLogger,
  type LogRecord,
  type Sink,
} from "../src/legacy.js";
import { getContextNoopLogger } from "../src/noop-logger.js";

const EMIT_BEFORE_INIT_WARNING =
  '[amplio] emit() before init(): event dropped. Call init({ service, env, sinks }) once at startup — in Next.js, import your telemetry/logger from instrumentation.ts so it runs on boot. If init() already runs at boot but events still drop, a bundler may have loaded a separate copy of @useamplio/amplio into this module graph (e.g. next dev --turbo) — add a side-effect import "../logger" to the file that emits, and check that only one version of @useamplio/amplio is installed. See https://github.com/alex-holovach/amplio/blob/main/packages/amplio/README.md#compatibility.';
const USE_LOGGER_DEPRECATED_WARNING =
  "[amplio] useLogger() is deprecated and will be removed before 1.0 — use getLogger() (same behavior; renamed because lint tools mistake useLogger for a React hook).";
const GET_LOGGER_OUTSIDE_SCOPE_WARNING =
  "[amplio] getLogger() called outside runWithLogger(); fields will be dropped. Establish request scope with middleware (runWithLogger), or use the logger facade for one-shot scripts.";

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
  resetEmitBeforeInitWarningForTests();
  resetUseLoggerOutsideScopeWarningForTests();
  resetUseLoggerDeprecationWarningForTests();
});

describe("dev warnings", () => {
  it("emit before init warns on every drop in dev-mode and drops the record without throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => createLogger().set({ a: 1 }).emit()).not.toThrow();
    expect(() => createLogger().set({ b: 2 }).emit()).not.toThrow();

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, EMIT_BEFORE_INIT_WARNING);
    expect(warn).toHaveBeenNthCalledWith(2, EMIT_BEFORE_INIT_WARNING);

    warn.mockRestore();
  });

  it("useLogger outside ALS warns once in dev and returns a noop", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = useLogger();
    const second = useLogger();

    expect(first).toBe(getContextNoopLogger());
    expect(second).toBe(getContextNoopLogger());
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, USE_LOGGER_DEPRECATED_WARNING);
    expect(warn).toHaveBeenNthCalledWith(2, GET_LOGGER_OUTSIDE_SCOPE_WARNING);

    warn.mockRestore();
  });

  it("hasAmbientLogger is false outside runWithLogger, true inside, and does not warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(hasAmbientLogger()).toBe(false);

    runWithLogger(createLogger(), () => {
      expect(hasAmbientLogger()).toBe(true);
    });

    expect(hasAmbientLogger()).toBe(false);
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  it("createRequestLogger record contains request_id and http.method/http.path but no top-level method/path", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = createRequestLogger({
      method: "POST",
      path: "/users",
      requestId: "req_123",
    })
      .set({ status: 201 })
      .emit();

    expect(record?.request_id).toBe("req_123");
    expect(record?.http).toEqual({ method: "POST", path: "/users" });
    expect(record?.method).toBeUndefined();
    expect(record?.path).toBeUndefined();
    expect(record?.event).toBe("http.request");
    expect(record?.["@event"]).toBe("http.request");
    expect(records).toHaveLength(1);
  });
});
