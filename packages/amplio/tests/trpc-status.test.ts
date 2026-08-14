import { describe, expect, it } from "vitest";
import { trpcErrorHttpStatus } from "../src/legacy.js";

describe("trpcErrorHttpStatus", () => {
  it("maps known tRPC error codes to HTTP status", () => {
    expect(trpcErrorHttpStatus({ code: "UNAUTHORIZED" })).toBe(401);
    expect(trpcErrorHttpStatus({ code: "NOT_FOUND" })).toBe(404);
    expect(trpcErrorHttpStatus({ code: "TOO_MANY_REQUESTS" })).toBe(429);
  });

  it("defaults to 500 for unknown codes and non-object input", () => {
    expect(trpcErrorHttpStatus({ code: "UNKNOWN_CODE" })).toBe(500);
    expect(trpcErrorHttpStatus(null)).toBe(500);
    expect(trpcErrorHttpStatus("error")).toBe(500);
    expect(trpcErrorHttpStatus({ message: "no code" })).toBe(500);
  });
});
