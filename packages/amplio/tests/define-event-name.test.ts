import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineEvent } from "../src/index.js";

describe("defineEvent name", () => {
  it("rejects object-style options mistaken for name", () => {
    expect(() =>
      defineEvent(
        { name: "job.completed", schema: z.object({}) } as unknown as string,
      ),
    ).toThrow(/name must be a non-empty string/);
  });

  it("rejects names without a dot", () => {
    expect(() => defineEvent("checkout")).toThrow(/Invalid event name/);
  });

  it("rejects uppercase segments", () => {
    expect(() => defineEvent("Auth.User.SignedUp")).toThrow(/Invalid event name/);
  });

  it("accepts domain.entity.action and domain.action forms", () => {
    expect(defineEvent("auth.user.signed_up").name).toBe("auth.user.signed_up");
    expect(defineEvent("email.sent").name).toBe("email.sent");
    expect(
      defineEvent(
        "job.completed",
        z.object({ job: z.object({ id: z.string() }) }),
      ).name,
    ).toBe("job.completed");
  });
});
