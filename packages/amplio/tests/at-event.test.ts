import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineEvent, init, logger, resetConfigForTests } from "../src/legacy.js";

beforeEach(() => {
  resetConfigForTests();
  init({ service: "api", env: "test", sinks: [() => {}] });
});

describe("@event field", () => {
  it("sets @event and event to defineEvent name", () => {
    const def = defineEvent(
      "payment.order.paid",
      z.object({ order: z.object({ id: z.string() }) }),
    );
    const record = logger.event(def).set({ order: { id: "o1" } }).emit();
    expect(record?.event).toBe("payment.order.paid");
    expect(record?.["@event"]).toBe("payment.order.paid");
  });
});
