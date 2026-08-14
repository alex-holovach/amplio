import { beforeEach, describe, expect, it } from "vitest";
import { createLogger, init, resetConfigForTests } from "../src/legacy.js";
import type { LogRecord, Sink } from "../src/legacy.js";

const capture = (): { records: LogRecord[]; sink: Sink } => {
  const records: LogRecord[] = [];
  return {
    records,
    sink: (record) => {
      records.push(record);
    },
  };
};

beforeEach(() => {
  resetConfigForTests();
});

describe("PII redaction on emit (default redact)", () => {
  it("redacts credit card-like number in string field", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    createLogger()
      .set({ note: "charged card 4111111111111111 for order" })
      .emit();

    expect(records[0]?.note).toBe("charged card [REDACTED] for order");
    expect(records[0]?.note).not.toContain("4111111111111111");
  });

  it("redacts JWT-like string in string field", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    createLogger()
      .set({ note: `session token ${jwt} expired` })
      .emit();

    expect(records[0]?.note).not.toContain("eyJ");
    expect(records[0]?.note).toContain("[REDACTED]");
  });

  it("redacts spaced and dashed PANs", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    createLogger()
      .set({
        spaced: "pay with 4111 1111 1111 1111 now",
        dashed: "pay with 4111-1111-1111-1111 now",
        amex: "amex 3782 822463 10005 works",
      })
      .emit();

    expect(records[0]?.spaced).toBe("pay with [REDACTED] now");
    expect(records[0]?.dashed).toBe("pay with [REDACTED] now");
    expect(records[0]?.amex).toBe("amex [REDACTED] works");
  });

  it("keeps Luhn-invalid card-shaped numbers (false-positive guard)", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    createLogger()
      .set({
        luhnFail: "id 4111111111111112 is not a card",
        wrongPrefix: "ref 9999888877776666 tracked",
      })
      .emit();

    expect(records[0]?.luhnFail).toBe("id 4111111111111112 is not a card");
    expect(records[0]?.wrongPrefix).toBe("ref 9999888877776666 tracked");
  });

  it("redacts card-ish field names", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    createLogger()
      .set({
        card: "anything",
        credit_card: "anything",
        pan: "anything",
        card_number: "anything",
      })
      .emit();

    expect(records[0]?.card).toBe("[REDACTED]");
    expect(records[0]?.credit_card).toBe("[REDACTED]");
    expect(records[0]?.pan).toBe("[REDACTED]");
    expect(records[0]?.card_number).toBe("[REDACTED]");
  });

  it("redacts field named password", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    createLogger()
      .set({ password: "super-secret-password" })
      .emit();

    expect(records[0]?.password).toBe("[REDACTED]");
    expect(records[0]?.password).not.toContain("super-secret");
  });
});
