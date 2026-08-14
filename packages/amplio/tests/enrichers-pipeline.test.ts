import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createLogger,
  defineEvent,
  init,
  logger,
  resetConfigForTests,
  type Enricher,
  type LogRecord,
  type Sink,
} from "../src/legacy.js";

beforeEach(() => {
  resetConfigForTests();
});

describe("enrichers pipeline", () => {
  it("runs enrichers before validation and before sinks", () => {
    const order: string[] = [];
    const enricher: Enricher = (record) => {
      order.push("enricher");
      return { ...record, enriched: true, user: { id: "from-enricher" } };
    };
    const sink: Sink = () => {
      order.push("sink");
    };

    init({ service: "api", env: "test", sinks: [sink], enrichers: [enricher] });

    const def = defineEvent(
      "auth.user.signed_up",
      z.object({ user: z.object({ id: z.string() }) }),
    );

    // Missing user.id in set — enricher supplies it before validation.
    const record = logger.event(def).emit();

    expect(order).toEqual(["enricher", "sink"]);
    expect(record?.enriched).toBe(true);
    expect(record?.user).toEqual({ id: "from-enricher" });
    expect(record?.event).toBe("auth.user.signed_up");
    expect(record?.["@event"]).toBe("auth.user.signed_up");
  });

  it("validated shape fields win over enricher fields on overlap", () => {
    // set → enricher overwrites user.id → validate transforms → merge keeps validated.
    const enricher: Enricher = (record) => ({
      ...record,
      user: { id: "from-enricher" },
      tagged: true,
    });

    init({
      service: "api",
      env: "test",
      sinks: [() => {}],
      enrichers: [enricher],
    });

    const def = defineEvent(
      "auth.user.signed_up",
      z.object({
        user: z.object({
          id: z.string().transform((id) => `validated:${id}`),
        }),
      }),
    );

    const record = logger
      .event(def)
      .set({ user: { id: "from-set" } })
      .emit();

    expect(record?.user).toEqual({ id: "validated:from-enricher" });
    expect(record?.tagged).toBe(true);
  });

  it("runs enrichers in registration order", () => {
    const first: Enricher = (record) => ({ ...record, a: 1, tag: "first" });
    const second: Enricher = (record) => {
      const a = typeof record.a === "number" ? record.a : 0;
      return { ...record, b: a + 1, tag: "second" };
    };

    init({
      service: "api",
      env: "test",
      sinks: [() => {}],
      enrichers: [first, second],
    });

    const record = logger.create().emit();
    expect(record?.a).toBe(1);
    expect(record?.b).toBe(2);
    expect(record?.tag).toBe("second");
  });

  it("later enricher sees fields added by an earlier enricher", () => {
    const mem: Sink = () => {};

    init({
      service: "api",
      env: "test",
      sinks: [mem],
      enrichers: [
        () => ({ step: 1 }),
        (rec) => ({ step: (rec.step as number) + 1 }),
      ],
    });
    const record = createLogger().emit();
    expect(record?.step).toBe(2);
  });

  it("enricher return replaces payload (does not deep-merge prior .set() fields)", () => {
    const mem: Sink = () => {};

    init({
      service: "api",
      env: "test",
      sinks: [mem],
      // No spread of prior fields — return value is the new payload.
      enrichers: [() => ({ step: 1 })],
    });

    const record = createLogger().set({ feature: "checkout" }).emit();
    expect(record?.step).toBe(1);
    expect(record?.feature).toBeUndefined();
  });

  it("enricher that spreads prior record keeps .set() fields", () => {
    const mem: Sink = () => {};

    init({
      service: "api",
      env: "test",
      sinks: [mem],
      enrichers: [(rec) => ({ ...rec, step: 1 })],
    });

    const record = createLogger().set({ feature: "checkout" }).emit();
    expect(record?.feature).toBe("checkout");
    expect(record?.step).toBe(1);
  });

  it("init() returns logger facade", () => {
    const facade = init({ service: "api", env: "test", sinks: [() => {}] });
    expect(typeof facade.create).toBe("function");
    expect(typeof facade.event).toBe("function");
    const record = facade.create().set({ ok: true }).emit();
    expect(record?.ok).toBe(true);
  });
});
