import { beforeEach, describe, expect, it } from "vitest";
import {
  createLogger,
  getConfig,
  init,
  resetConfigForTests,
  type Enricher,
  type LogRecord,
  type Sink,
} from "../src/legacy.js";

const memorySink = (): { records: LogRecord[]; sink: Sink } => {
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

describe("init reconfigure", () => {
  it("second init replaces service and sinks", () => {
    const sinkA = memorySink();
    init({ service: "service-a", env: "test", sinks: [sinkA.sink] });

    const recordA = createLogger().set({ step: "first" }).emit();
    expect(recordA.service).toBe("service-a");
    expect(sinkA.records).toHaveLength(1);
    expect(sinkA.records[0]).toBe(recordA);

    const sinkB = memorySink();
    init({ service: "service-b", env: "test", sinks: [sinkB.sink] });

    const recordB = createLogger().set({ step: "second" }).emit();
    expect(recordB.service).toBe("service-b");
    expect(sinkB.records).toHaveLength(1);
    expect(sinkB.records[0]).toBe(recordB);

    expect(sinkA.records).toHaveLength(1);
  });
  it("second init replaces enrichers", () => {
    const sinkA = memorySink();
    const tagA: Enricher = (record) => ({ ...record, tag: "a" });
    init({
      service: "service-a",
      env: "test",
      sinks: [sinkA.sink],
      enrichers: [tagA],
    });

    const recordA = createLogger().set({ step: "first" }).emit();
    expect(recordA.tag).toBe("a");
    expect(sinkA.records[0]?.tag).toBe("a");

    const sinkB = memorySink();
    const tagB: Enricher = (record) => ({ ...record, tag: "b" });
    init({
      service: "service-b",
      env: "test",
      sinks: [sinkB.sink],
      enrichers: [tagB],
    });

    const recordB = createLogger().set({ step: "second" }).emit();
    expect(recordB.tag).toBe("b");
    expect(recordB.tag).not.toBe("a");
    expect(sinkB.records).toHaveLength(1);
    expect(sinkB.records[0]?.tag).toBe("b");
    expect(sinkA.records).toHaveLength(1);
    expect(sinkA.records[0]?.tag).toBe("a");
  });
  it("second init that omits enrichers clears previous enrichers", () => {
    const sinkA = memorySink();
    const tag: Enricher = (record) => ({ ...record, tagged: true });
    init({
      service: "service-a",
      env: "test",
      sinks: [sinkA.sink],
      enrichers: [tag],
    });

    const recordA = createLogger().set({ step: "first" }).emit();
    expect(recordA.tagged).toBe(true);
    expect(sinkA.records[0]?.tagged).toBe(true);

    const sinkB = memorySink();
    init({ service: "service-b", env: "test", sinks: [sinkB.sink] });

    const recordB = createLogger().set({ step: "second" }).emit();
    expect(recordB.tagged).toBeUndefined();
    expect(sinkB.records).toHaveLength(1);
    expect(sinkB.records[0]?.tagged).toBeUndefined();
    expect(sinkA.records).toHaveLength(1);
    expect(sinkA.records[0]?.tagged).toBe(true);
  });
  it("second init with enrichers: [] clears previous enrichers", () => {
    const sinkA = memorySink();
    const tag: Enricher = (record) => ({ ...record, tagged: true });
    init({
      service: "service-a",
      env: "test",
      sinks: [sinkA.sink],
      enrichers: [tag],
    });

    const recordA = createLogger().set({ step: "first" }).emit();
    expect(recordA.tagged).toBe(true);
    expect(sinkA.records[0]?.tagged).toBe(true);

    const sinkB = memorySink();
    init({
      service: "service-b",
      env: "test",
      sinks: [sinkB.sink],
      enrichers: [],
    });

    const recordB = createLogger().set({ step: "second" }).emit();
    expect(recordB.tagged).toBeUndefined();
    expect(sinkB.records).toHaveLength(1);
    expect(sinkB.records[0]?.tagged).toBeUndefined();
    expect(getConfig().enrichers).toEqual([]);
    expect(sinkA.records).toHaveLength(1);
    expect(sinkA.records[0]?.tagged).toBe(true);
  });
  it("second init replaces sampling config", () => {
    const sinkA = memorySink();
    init({
      service: "service-a",
      env: "test",
      sinks: [sinkA.sink],
      sampling: { rate: 0 },
    });

    createLogger().set({ step: "first" }).emit();
    expect(sinkA.records).toHaveLength(0);

    const sinkB = memorySink();
    init({
      service: "service-b",
      env: "test",
      sinks: [sinkB.sink],
      sampling: { rate: 1 },
    });

    const recordB = createLogger().set({ step: "second" }).emit();
    expect(recordB.service).toBe("service-b");
    expect(sinkB.records).toHaveLength(1);
    expect(sinkB.records[0]).toBe(recordB);
    expect(sinkA.records).toHaveLength(0);
  });

  it("second init that omits sampling clears previous sampling", () => {
    const sinkA = memorySink();
    init({
      service: "service-a",
      env: "test",
      sinks: [sinkA.sink],
      sampling: { rate: 0 },
    });

    createLogger().set({ step: "first" }).emit();
    expect(sinkA.records).toHaveLength(0);

    const sinkB = memorySink();
    init({
      service: "service-b",
      env: "test",
      sinks: [sinkB.sink],
    });

    const recordB = createLogger().set({ step: "second" }).emit();
    expect(recordB.service).toBe("service-b");
    expect(sinkB.records).toHaveLength(1);
    expect(sinkB.records[0]).toBe(recordB);
    expect(sinkA.records).toHaveLength(0);
  });
  it("second init replaces redact: false with default redaction", () => {
    const sinkA = memorySink();
    init({
      service: "service-a",
      env: "test",
      redact: false,
      sinks: [sinkA.sink],
    });

    createLogger()
      .set({ user: { email: "user@example.com", id: "u1" } })
      .emit();
    expect(sinkA.records[0]?.user).toEqual({
      email: "user@example.com",
      id: "u1",
    });

    const sinkB = memorySink();
    init({ service: "service-b", env: "test", sinks: [sinkB.sink] });

    createLogger()
      .set({ user: { email: "user@example.com", id: "u1" } })
      .emit();
    expect(sinkB.records[0]?.user).toEqual({
      email: "[REDACTED]",
      id: "u1",
    });
    expect(sinkA.records[0]?.user).toEqual({
      email: "user@example.com",
      id: "u1",
    });
  });
});
