import { describe, it, expect, beforeEach } from "vitest";
import { createLogger, resetConfigForTests } from "../src/index.js";

beforeEach(() => {
  resetConfigForTests();
});

describe("library-first silence", () => {
  it("createLogger().set().emit() without init does not throw", () => {
    expect(() =>
      createLogger().set({ feature: "checkout", user_id: "u_1" }).emit(),
    ).not.toThrow();
  });

  it("emit() returns a record with auto fields and user context", () => {
    const record = createLogger()
      .set({ feature: "checkout", user_id: "u_1" })
      .emit();

    expect(record.service).toBe("");
    expect(record.env).toBe("");
    expect(record.feature).toBe("checkout");
    expect(record.user_id).toBe("u_1");
    expect(typeof record.timestamp).toBe("string");
    expect(typeof record.duration_ms).toBe("number");
    expect(record.success).toBe(true);
  });
});
