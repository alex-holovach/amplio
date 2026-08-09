import { describe, expect, it, beforeEach } from "vitest";
import { z } from "zod";
import * as core from "../src/index.js";
import {
  createLogger,
  defineEvent,
  init,
  logger,
  resetConfigForTests,
} from "../src/index.js";

beforeEach(() => {
  resetConfigForTests();
  init({ service: "api", env: "test", sinks: [() => {}] });
});

describe("public API surface", () => {
  it("exports the stable runtime entrypoints", () => {
    const requiredFns = [
      "defineEvent",
      "init",
      "createLogger",
      "createRequestLogger",
      "runWithLogger",
      "useLogger",
      "hasAmbientLogger",
      "createError",
      "AmplioValidationError",
      "flush",
    ] as const;

    for (const name of requiredFns) {
      expect(core[name], name).toBeTypeOf("function");
    }

    expect(core.logger).toBeTypeOf("object");
    expect(typeof core.logger.create).toBe("function");
    expect(typeof core.logger.event).toBe("function");
  });

  it("wide-event instances expose set/error/emit (+ sealed)", () => {
    const scope = createLogger().set({ a: 1 });
    expect("sealed" in scope).toBe(true);
    expect(typeof scope.sealed).toBe("boolean");
    expect(typeof scope.set).toBe("function");
    expect(typeof scope.emit).toBe("function");

    const def = defineEvent(
      "auth.user.signed_up",
      z.object({ user: z.object({ id: z.string() }) }),
    );
    const eventScope = logger.event(def).set({ user: { id: "u1" } });
    expect(typeof eventScope.set).toBe("function");
    expect(typeof eventScope.emit).toBe("function");
    expect((eventScope as { create?: unknown }).create).toBeUndefined();
    expect((eventScope as { info?: unknown }).info).toBeUndefined();
    expect((eventScope as { debug?: unknown }).debug).toBeUndefined();
    expect(typeof eventScope.error).toBe("function");
    expect((core as { getSealedNoopLogger?: unknown }).getSealedNoopLogger).toBeUndefined();
    expect((core as { getContextNoopLogger?: unknown }).getContextNoopLogger).toBeUndefined();
  });
});
