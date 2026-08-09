import { describe, expect, it } from "vitest";
import { redactRecord } from "../src/index.js";

describe("redactRecord URL-encoded PII", () => {
  it("redacts percent-encoded email in tRPC-style query string", () => {
    const redacted = redactRecord({
      http: {
        search:
          '?input=%7B%220%22%3A%7B%22json%22%3A%7B%22text%22%3A%22mail+bob%40corp.io+ok%22%7D%7D%7D',
      },
    });

    const search = (redacted.http as { search?: string })?.search ?? "";
    expect(search).toContain("[REDACTED]");
    expect(search).not.toContain("bob@corp.io");
    expect(search).not.toContain("bob%40corp.io");
  });

  it("redacts URL-encoded Bearer token in query string", () => {
    const redacted = redactRecord({
      http: {
        search: "?auth=Bearer%20eyJabc.def.ghi&ok=1",
      },
    });

    const search = (redacted.http as { search?: string })?.search ?? "";
    expect(search).toContain("[REDACTED]");
    expect(search).not.toContain("eyJabc");
    expect(search).not.toContain("Bearer%20");
  });

  it("leaves innocuous percent-encoded strings unchanged", () => {
    const redacted = redactRecord({ note: "a%20b/c" });
    expect(redacted.note).toBe("a%20b/c");
  });

  it("does not throw on malformed percent-encoding and falls back to raw scan", () => {
    expect(() => {
      const redacted = redactRecord({ note: "x%E0%A4%Ay" });
      expect(redacted.note).toBe("x%E0%A4%Ay");
    }).not.toThrow();
  });
});
