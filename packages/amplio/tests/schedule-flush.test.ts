import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  init,
  resetConfigForTests,
  resetScheduleFlushWarningForTests,
  scheduleFlush,
} from "../src/index.js";

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
});
