import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  init,
  resetConfigForTests,
  resetScheduleFlushWarningForTests,
  scheduleFlush,
} from "../src/legacy.js";

const CUTOFF_WARNING =
  "[amplio] async sinks may be cut off without waitUntil/after; pass waitUntil to scheduleFlush or call flush()";

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  resetConfigForTests();
  resetScheduleFlushWarningForTests();
});

describe("scheduleFlush", () => {
  it("passes flush() to waitUntil when provided", () => {
    init({ service: "api", env: "test", sinks: [async () => {}] });
    createLogger().set({ ok: true }).emit();

    const waitUntil = vi.fn();
    scheduleFlush({ waitUntil });

    expect(waitUntil).toHaveBeenCalledOnce();
    expect(waitUntil.mock.calls[0]![0]).toBeInstanceOf(Promise);
  });

  it("does not throw without waitUntil", () => {
    init({ service: "api", env: "test", sinks: [() => {}] });
    createLogger().emit();

    expect(() => scheduleFlush()).not.toThrow();
  });

  it("does not warn when all sinks are synchronous", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      init({ service: "api", env: "test", sinks: [() => {}] });
      createLogger().set({ ok: true }).emit();

      scheduleFlush();
      await settle();

      expect(warn).not.toHaveBeenCalledWith(CUTOFF_WARNING);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns once when async sink deliveries are pending and no waitUntil/after exists", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      init({ service: "api", env: "test", sinks: [async () => gate] });

      createLogger().set({ ok: true }).emit();
      scheduleFlush();
      createLogger().set({ ok: true }).emit();
      scheduleFlush();
      await settle();
      release();

      const cutoffWarnings = warn.mock.calls.filter(
        (call) => call[0] === CUTOFF_WARNING,
      );
      expect(cutoffWarnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
