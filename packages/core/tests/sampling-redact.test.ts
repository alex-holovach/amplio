import { describe, it, expect } from "vitest";
import { redactRecord, shouldSample } from "../src/index.js";
import type { LogRecord } from "../src/index.js";

describe("shouldSample", () => {
  it("keeps status>=400 when rate=0 and keep rule {field:'status',gte:400}", () => {
    const config = { rate: 0, keep: [{ field: "status", gte: 400 }] };

    expect(shouldSample({ status: 500 } as LogRecord, config)).toBe(true);
    expect(shouldSample({ status: 400 } as LogRecord, config)).toBe(true);
    expect(shouldSample({ status: 399 } as LogRecord, config)).toBe(false);
    expect(shouldSample({ status: 200 } as LogRecord, config)).toBe(false);
  });

  it("keeps duration_ms<=10 when rate=0 and keep rule {field:'duration_ms',lte:10}", () => {
    const config = { rate: 0, keep: [{ field: "duration_ms", lte: 10 }] };
    expect(shouldSample({ duration_ms: 5 } as LogRecord, config)).toBe(true);
    expect(shouldSample({ duration_ms: 10 } as LogRecord, config)).toBe(true);
    expect(shouldSample({ duration_ms: 11 } as LogRecord, config)).toBe(false);
    expect(shouldSample({ duration_ms: 100 } as LogRecord, config)).toBe(false);
  });

  it("keeps duration_ms in [10,20] when rate=0 and keep rule has gte+lte (AND range)", () => {
    const config = { rate: 0, keep: [{ field: "duration_ms", gte: 10, lte: 20 }] };
    expect(shouldSample({ duration_ms: 10 } as LogRecord, config)).toBe(true);
    expect(shouldSample({ duration_ms: 15 } as LogRecord, config)).toBe(true);
    expect(shouldSample({ duration_ms: 20 } as LogRecord, config)).toBe(true);
    expect(shouldSample({ duration_ms: 9 } as LogRecord, config)).toBe(false);
    expect(shouldSample({ duration_ms: 21 } as LogRecord, config)).toBe(false);
  });
});

describe("redactRecord", () => {
  it("redacts email, jwt in text, authorization field", () => {
    const redacted = redactRecord({
      email: "user@example.com",
      authorization: "Bearer secret-token",
      note: "token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    });

    expect(redacted.email).toBe("[REDACTED]");
    expect(redacted.authorization).toBe("[REDACTED]");
    expect(redacted.note).not.toContain("eyJ");
    expect(redacted.note).toContain("[REDACTED]");
  });
});
