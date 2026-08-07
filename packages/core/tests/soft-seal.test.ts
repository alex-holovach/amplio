import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, init, resetConfigForTests } from "../src/index.js";

beforeEach(() => {
  resetConfigForTests();
  init({ service: "api", env: "test", sinks: [() => {}] });
});

describe("soft seal", () => {
  it("second emit returns null and warns in development/test", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scope = createLogger().set({ ok: true });
    const first = scope.emit();
    const second = scope.emit();

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/emit\(\) ignored.*sealed/),
    );
    warn.mockRestore();
  });

  it("post-seal set is ignored with warning and does not throw", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scope = createLogger().set({ a: 1 });
    scope.emit();
    scope.set({ a: 2, b: 3 });

    expect(scope.sealed).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/set\(\) ignored.*sealed/),
    );
    warn.mockRestore();
  });

  it("post-seal set returns same logger for chaining", () => {
    const scope = createLogger();
    scope.emit();
    expect(scope.set({ x: 1 })).toBe(scope);
    expect(scope.set({ y: 2 })).toBe(scope);
  });
});

  it("create() after seal returns null and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scope = createLogger().set({ ok: true });
    scope.emit();
    const child = scope.create({ child: true });

    expect(child).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/create\(\) ignored.*sealed/),
    );
    warn.mockRestore();
  });

  it("event() after seal returns null and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { defineEvent } = await import("../src/index.js");
    const def = defineEvent("ops.tick.fired");
    const scope = createLogger().set({ ok: true });
    scope.emit();
    const bound = scope.event(def);

    expect(bound).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/event\(\) ignored.*sealed/),
    );
    warn.mockRestore();
  });

