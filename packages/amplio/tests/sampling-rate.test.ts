import { describe, it, expect } from "vitest";
import { shouldSample } from "../src/index.js";
import type { LogRecord } from "../src/index.js";

const config = { rate: 0.1, keep: [{ field: "status", gte: 400 }] };

// hashRecord is deterministic on event/request_id/timestamp (see sampling.ts).
// These records hash below and above rate=0.1 — same outcomes as random 0.05 / 0.9.
const keptRecord: LogRecord = {
  event: "test",
  request_id: "r6",
  timestamp: "t",
  status: 200,
};

const droppedRecord: LogRecord = {
  event: "test",
  request_id: "r0",
  timestamp: "t",
  status: 200,
};

describe("shouldSample rate", () => {
  it("drops events without keep rules when hash >= rate", () => {
    expect(shouldSample(droppedRecord, config)).toBe(false);
  });

  it("keeps events without keep rules when hash < rate", () => {
    expect(shouldSample(keptRecord, config)).toBe(true);
  });

  it("keeps status>=400 via keep rule even when hash >= rate", () => {
    expect(
      shouldSample({ ...droppedRecord, status: 500 } as LogRecord, config),
    ).toBe(true);
    expect(
      shouldSample({ ...droppedRecord, status: 400 } as LogRecord, config),
    ).toBe(true);
  });

  it("keeps field equals via keep rule even when hash >= rate", () => {
    const equalsConfig = { rate: 0.1, keep: [{ field: "severity", equals: "ERROR" }] };
    expect(
      shouldSample({ ...droppedRecord, severity: "ERROR" } as LogRecord, equalsConfig),
    ).toBe(true);
    expect(
      shouldSample({ ...droppedRecord, severity: "INFO" } as LogRecord, equalsConfig),
    ).toBe(false);
  });

  it("keeps field matches via keep rule even when hash >= rate", () => {
    const matchesConfig = { rate: 0.1, keep: [{ field: "path", matches: /^\/admin/ }] };
    expect(
      shouldSample({ ...droppedRecord, path: "/admin/users" } as LogRecord, matchesConfig),
    ).toBe(true);
    expect(
      shouldSample({ ...droppedRecord, path: "/health" } as LogRecord, matchesConfig),
    ).toBe(false);
  });

  it("keep matches only applies to string values (non-string → no match, rate 0 drops)", () => {
    const config = { rate: 0, keep: [{ field: "status", matches: /^5/ }] };
    expect(shouldSample({ status: 503 } as LogRecord, config)).toBe(false);
    expect(shouldSample({ status: "503" } as LogRecord, config)).toBe(true);
  });

  it("keep gte/lte only match number field values (string/non-number → no match, rate 0 drops)", () => {
    const config = { rate: 0, keep: [{ field: "status", gte: 500 }] };
    expect(shouldSample({ status: "503" } as LogRecord, config)).toBe(false);
    expect(shouldSample({ status: 503 } as LogRecord, config)).toBe(true);
  });

  it("keep with matches+gte: number skips matches and falls through to gte; string uses matches only", () => {
    const config = {
      rate: 0,
      keep: [{ field: "status", matches: /^5/, gte: 500 }],
    };
    expect(shouldSample({ status: 503 } as LogRecord, config)).toBe(true); // gte
    expect(shouldSample({ status: 404 } as LogRecord, config)).toBe(false);
    // string path: matches applies and returns (no fallthrough to gte)
    expect(shouldSample({ status: "503" } as LogRecord, config)).toBe(true); // /^5/.test("503")
    expect(shouldSample({ status: "404" } as LogRecord, config)).toBe(false);
  });

  it("keeps nested user.plan equals via keep rule even when hash >= rate", () => {
    const planConfig = { rate: 0.1, keep: [{ field: "user.plan", equals: "enterprise" }] };
    expect(
      shouldSample(
        { ...droppedRecord, user: { plan: "enterprise" } } as LogRecord,
        planConfig,
      ),
    ).toBe(true);
    expect(
      shouldSample(
        { ...droppedRecord, user: { plan: "free" } } as LogRecord,
        planConfig,
      ),
    ).toBe(false);
  });

  it("always samples when rate is 1", () => {
    const alwaysConfig = { rate: 1 };
    const records: LogRecord[] = [
      droppedRecord,
      keptRecord,
      { event: "other", request_id: "r99", timestamp: "t2", status: 200 },
      { event: "other", request_id: "r42", timestamp: "t3", status: 500 },
      { event: "x", request_id: "abc", timestamp: "2026-01-01", severity: "ERROR" },
    ];

    for (const record of records) {
      expect(shouldSample(record, alwaysConfig)).toBe(true);
    }
  });

  it("always samples when rate is 1 even if record would not match keep", () => {
    // Keep rules must not gate rate=1: non-matching records still sample.
    const alwaysWithKeep = {
      rate: 1,
      keep: [
        { field: "status", gte: 400 },
        { field: "severity", equals: "ERROR" },
      ],
    };
    const nonMatching: LogRecord[] = [
      droppedRecord, // status 200 — fails gte/equals keep
      keptRecord,
      { event: "ok", request_id: "r7", timestamp: "t", status: 204, severity: "INFO" },
      { event: "health", request_id: "r8", timestamp: "t", path: "/health" },
    ];

    for (const record of nonMatching) {
      expect(shouldSample(record, alwaysWithKeep)).toBe(true);
    }
  });


  it("always samples when rate is >= 1 (e.g. rate: 2) with empty/no keep", () => {
    const typicalRecord: LogRecord = {
      event: "test",
      request_id: "r6",
      timestamp: "t",
      status: 200,
    };
    expect(shouldSample(typicalRecord, { rate: 2 })).toBe(true);
    expect(shouldSample(typicalRecord, { rate: 2, keep: [] })).toBe(true);
  });

  it('always samples when sampling is {} (rate defaults to 1)', () => {
    const typical: LogRecord = {
      event: 'test',
      request_id: 'r6',
      timestamp: 't',
      status: 200,
    };
    expect(shouldSample(typical, {})).toBe(true);
  });

  it("returns true when sampling config is omitted or undefined (keep all)", () => {
    const typicalRecord: LogRecord = {
      event: "test",
      request_id: "r6",
      timestamp: "t",
      status: 200,
    };
    expect(shouldSample(typicalRecord)).toBe(true);
    expect(shouldSample(typicalRecord, undefined)).toBe(true);
  });

  it("drops all records when rate is 0 with empty keep (or no keep)", () => {
    const noKeep = { rate: 0 };
    const emptyKeep = { rate: 0, keep: [] as { field: string; gte: number }[] };
    const typical: LogRecord = {
      event: "test",
      request_id: "r6",
      timestamp: "t",
      status: 200,
    };

    expect(shouldSample(typical, noKeep)).toBe(false);
    expect(shouldSample(typical, emptyKeep)).toBe(false);
    expect(shouldSample(droppedRecord, noKeep)).toBe(false);
    expect(shouldSample(keptRecord, emptyKeep)).toBe(false);
  });

  it("drops all records when rate < 0 (same as rate <= 0) with empty/no keep", () => {
    const typical: LogRecord = {
      event: "test",
      request_id: "r6",
      timestamp: "t",
      status: 200,
    };
    expect(shouldSample(typical, { rate: -1 })).toBe(false);
    expect(shouldSample(typical, { rate: -0.5 })).toBe(false);
  });

  it("keep rules do not match when the field is absent/undefined (rate: 0 → drop)", () => {
    const config = { rate: 0, keep: [{ field: "status", gte: 500 }] };
    expect(shouldSample({} as LogRecord, config)).toBe(false);
    expect(shouldSample({ severity: "ERROR" } as LogRecord, config)).toBe(false);
    expect(shouldSample({ status: 503 } as LogRecord, config)).toBe(true);
  });

  it("ORs multiple keep rules when rate is 0", () => {
    const orKeep = {
      rate: 0,
      keep: [
        { field: "severity", equals: "ERROR" },
        { field: "status", gte: 500 },
      ],
    };
    // Matches only the second rule (status>=500), not severity===ERROR.
    expect(
      shouldSample(
        { ...droppedRecord, severity: "INFO", status: 503 } as LogRecord,
        orKeep,
      ),
    ).toBe(true);
    // Matches neither keep rule → dropped by rate 0.
    expect(
      shouldSample(
        { ...droppedRecord, severity: "INFO", status: 200 } as LogRecord,
        orKeep,
      ),
    ).toBe(false);
  });

  it("nested keep path does not match when intermediate segment is missing or not an object (rate: 0 → drop)", () => {
    const config = { rate: 0, keep: [{ field: "user.plan", equals: "enterprise" }] };
    expect(shouldSample({} as LogRecord, config)).toBe(false);
    expect(shouldSample({ user: "x" } as LogRecord, config)).toBe(false);
    expect(shouldSample({ user: {} } as LogRecord, config)).toBe(false);
    expect(shouldSample({ user: { plan: "enterprise" } } as LogRecord, config)).toBe(true);
  });


  it("keep equals: null matches null field (Object.is) and not absent/undefined", () => {
    const config = { rate: 0, keep: [{ field: "err", equals: null }] };
    expect(shouldSample({ err: null } as LogRecord, config)).toBe(true);
    expect(shouldSample({} as LogRecord, config)).toBe(false);
    expect(shouldSample({ err: undefined } as unknown as LogRecord, config)).toBe(false);
    expect(shouldSample({ err: "x" } as LogRecord, config)).toBe(false);
  });

  it("keep equals works for boolean false (Object.is)", () => {
    const config = { rate: 0, keep: [{ field: "ok", equals: false }] };
    expect(shouldSample({ ok: false } as LogRecord, config)).toBe(true);
    expect(shouldSample({ ok: true } as LogRecord, config)).toBe(false);
    expect(shouldSample({} as LogRecord, config)).toBe(false);
  });

  it("keep equals: 0 matches numeric zero (not absent)", () => {
    const config = { rate: 0, keep: [{ field: "code", equals: 0 }] };
    expect(shouldSample({ code: 0 } as LogRecord, config)).toBe(true);
    expect(shouldSample({ code: 1 } as LogRecord, config)).toBe(false);
    expect(shouldSample({} as LogRecord, config)).toBe(false);
  });

  it('keep equals: "" matches empty string field (not absent)', () => {
    const config = { rate: 0, keep: [{ field: "msg", equals: "" }] };
    expect(shouldSample({ msg: "" } as LogRecord, config)).toBe(true);
    expect(shouldSample({ msg: "x" } as LogRecord, config)).toBe(false);
    expect(shouldSample({} as LogRecord, config)).toBe(false);
  });

  it("keeps nested user.score via keep gte on dotted path when rate is 0", () => {
    const config = { rate: 0, keep: [{ field: "user.score", gte: 90 }] };
    expect(shouldSample({ user: { score: 90 } } as LogRecord, config)).toBe(true);
    expect(shouldSample({ user: { score: 89 } } as LogRecord, config)).toBe(false);
    expect(shouldSample({ user: {} } as LogRecord, config)).toBe(false);
  });

  it("when keep rule has both equals and matches, only equals is evaluated", () => {
    const config = {
      rate: 0,
      keep: [{ field: "path", equals: "/exact", matches: /^\/admin/ }],
    };
    expect(shouldSample({ path: "/exact" } as LogRecord, config)).toBe(true);
    // matches alone would keep, but equals fails first
    expect(shouldSample({ path: "/admin/x" } as LogRecord, config)).toBe(false);
  });

  it("when keep rule has both equals and gte, only equals is evaluated", () => {
    const config = {
      rate: 0,
      keep: [{ field: "status", equals: 503, gte: 500 }],
    };
    expect(shouldSample({ status: 503 } as LogRecord, config)).toBe(true);
    // would match gte alone
    expect(shouldSample({ status: 500 } as LogRecord, config)).toBe(false);
  });

  it("when keep rule has both equals and lte, only equals is evaluated", () => {
    const config = {
      rate: 0,
      keep: [{ field: "status", equals: 200, lte: 299 }],
    };
    expect(shouldSample({ status: 200 } as LogRecord, config)).toBe(true);
    expect(shouldSample({ status: 201 } as LogRecord, config)).toBe(false); // would match lte alone
  });

  it("keep but no rate defaults rate to 1 — always samples even when keep would not match", () => {
    const config = { keep: [{ field: "severity", equals: "ERROR" }] }; // no rate
    expect(shouldSample({ severity: "INFO" } as LogRecord, config)).toBe(true);
    expect(shouldSample({ severity: "ERROR" } as LogRecord, config)).toBe(true);
  });

});
