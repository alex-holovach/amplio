import { beforeEach, describe, expect, it, expectTypeOf } from "vitest";
import { z } from "zod";
import { defineEvent, init, logger, resetConfigForTests } from "../src/legacy.js";

const UserUpdated = defineEvent(
  "user.updated",
  z.object({
    user: z.object({
      id: z.string(),
      email: z.string().optional(),
      profile: z.object({ name: z.string() }).optional(),
    }),
  }),
);

beforeEach(() => {
  resetConfigForTests();
  init({ service: "api", env: "test", sinks: [() => {}] });
});

describe("DeepPartial on EventLogger.set", () => {
  it("deep-merges nested incremental .set() calls at runtime", () => {
    const scope = logger
      .event(UserUpdated)
      .set({ user: { id: "u_1" } })
      .set({ user: { email: "a@b.c" } });

    const record = scope.emit();

    expect(record?.user).toEqual({ id: "u_1", email: "[REDACTED]" });
  });

  it("accepts nested partials via logger.event initial", () => {
    const record = logger
      .event(UserUpdated, { user: { id: "u_2" } })
      .set({ user: { email: "b@c.d" } })
      .emit();

    expect(record?.user).toEqual({ id: "u_2", email: "[REDACTED]" });
  });

  it("types nested patches as DeepPartial", () => {
    const scope = logger.event(UserUpdated);
    expectTypeOf(scope.set).parameter(0).toMatchTypeOf<{
      user?: { id?: string; email?: string; profile?: { name?: string } };
    }>();
  });
});
