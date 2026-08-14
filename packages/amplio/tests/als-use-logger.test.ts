import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createLogger,
  getLogger,
  init,
  resetConfigForTests,
  resetUseLoggerDeprecationWarningForTests,
  resetUseLoggerOutsideScopeWarningForTests,
  runWithLogger,
  useLogger,
} from "../src/legacy.js";
import { getContextNoopLogger } from "../src/noop-logger.js";
import type { LogRecord, Sink } from "../src/legacy.js";

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
  resetUseLoggerOutsideScopeWarningForTests();
  resetUseLoggerDeprecationWarningForTests();
});

describe("ALS useLogger", () => {
  it("async runWithLogger: set via useLogger and emit reaches memory sink", async () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    await runWithLogger(createLogger(), async () => {
      useLogger().set({ a: 1 });
      useLogger().emit();
    });

    expect(records).toHaveLength(1);
    expect(records[0]!.a).toBe(1);
  });

  it("useLogger() outside runWithLogger returns context no-op logger", () => {
    const noop = useLogger();
    expect(noop).toBe(getContextNoopLogger());
    expect(noop.sealed).toBe(true);
  });

  it("useLogger() outside runWithLogger warns once on call in development/test", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useLogger().set({ a: 1 });
    useLogger().set({ b: 2 });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      "[amplio] useLogger() is deprecated and will be removed before 1.0 — use getLogger() (same behavior; renamed because lint tools mistake useLogger for a React hook).",
    );
    expect(warn).toHaveBeenNthCalledWith(
      2,
      "[amplio] getLogger() called outside runWithLogger(); fields will be dropped. Establish request scope with middleware (runWithLogger), or use the logger facade for one-shot scripts.",
    );
    warn.mockRestore();
  });

  it("getLogger inside runWithLogger returns the ambient logger", async () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    await runWithLogger(createLogger(), async () => {
      getLogger().set({ a: 1 });
      getLogger().emit();
    });

    expect(records).toHaveLength(1);
    expect(records[0]!.a).toBe(1);
  });

  it("useLogger emits deprecation warning once in dev and still works inside runWithLogger", async () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runWithLogger(createLogger(), async () => {
      useLogger().set({ via: "useLogger" }).emit();
    });

    expect(records).toHaveLength(1);
    expect(records[0]!.via).toBe("useLogger");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[amplio] useLogger() is deprecated and will be removed before 1.0 — use getLogger() (same behavior; renamed because lint tools mistake useLogger for a React hook).",
    );

    warn.mockRestore();
  });

  it("nested runWithLogger restores outer logger after inner exits", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const outer = createLogger({ scope: "A" });
    const inner = createLogger({ scope: "B" });

    runWithLogger(outer, () => {
      expect(useLogger()).toBe(outer);

      runWithLogger(inner, () => {
        expect(useLogger()).toBe(inner);
        useLogger().set({ from: "inner" }).emit();
      });

      expect(useLogger()).toBe(outer);
    });

    expect(useLogger()).toBe(getContextNoopLogger());
    expect(records).toHaveLength(1);
    expect(records[0]!.scope).toBe("B");
    expect(records[0]!.from).toBe("inner");
  });
});
