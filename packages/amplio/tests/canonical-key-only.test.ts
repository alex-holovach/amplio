import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createRequestLogger,
  defineEvent,
  init,
  logger,
  resetConfigForTests,
} from "../src/legacy.js";

beforeEach(() => {
  resetConfigForTests();
});

describe("canonicalKeyOnly", () => {
  it("drops the duplicate event key when canonicalKeyOnly is true", () => {
    init({
      service: "api",
      env: "test",
      sinks: [() => {}],
      canonicalKeyOnly: true,
    });

    const requestRecord = createRequestLogger({ method: "GET", path: "/health" }).emit();
    expect(requestRecord?.["@event"]).toBe("http.request");
    expect(requestRecord?.event).toBeUndefined();

    const def = defineEvent("auth.user.signed_up", z.object({ user_id: z.string() }));
    const eventRecord = logger.event(def).set({ user_id: "u1" }).emit();
    expect(eventRecord?.["@event"]).toBe("auth.user.signed_up");
    expect(eventRecord?.event).toBeUndefined();
  });

  it("keeps both event and @event by default", () => {
    init({ service: "api", env: "test", sinks: [() => {}] });

    const requestRecord = createRequestLogger({ method: "GET", path: "/health" }).emit();
    expect(requestRecord?.event).toBe("http.request");
    expect(requestRecord?.["@event"]).toBe("http.request");

    const def = defineEvent("auth.user.signed_up", z.object({ user_id: z.string() }));
    const eventRecord = logger.event(def).set({ user_id: "u1" }).emit();
    expect(eventRecord?.event).toBe("auth.user.signed_up");
    expect(eventRecord?.["@event"]).toBe("auth.user.signed_up");
  });
});
