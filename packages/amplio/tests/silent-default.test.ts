import { describe, it, expect, beforeEach, vi } from "vitest";
import { createLogger, resetConfigForTests } from "../src/legacy.js";

beforeEach(() => {
  resetConfigForTests();
});

describe("library-first silence", () => {
  it("createLogger().set().emit() without init does not throw", () => {
    expect(() =>
      createLogger().set({ feature: "checkout", user_id: "u_1" }).emit(),
    ).not.toThrow();
  });

  it("emit() before init drops the record", () => {
    const record = createLogger()
      .set({ feature: "checkout", user_id: "u_1" })
      .emit();

    expect(record).toBeNull();
  });

  it("emit() before init is silent in production", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const record = createLogger().set({ feature: "checkout" }).emit();
      expect(record).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});
