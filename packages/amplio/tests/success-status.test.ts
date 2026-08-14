import { beforeEach, describe, expect, it } from "vitest";
import { createLogger, init, resetConfigForTests, type LogRecord, type Sink } from "../src/legacy.js";

beforeEach(() => {
  resetConfigForTests();
});

describe("success from status", () => {
  const memorySink = (): { records: LogRecord[]; sink: Sink } => {
    const records: LogRecord[] = [];
    return {
      records,
      sink: (record) => {
        records.push(record);
      },
    };
  };

  it("status 200 -> success true on emit", () => {
    const { records, sink } = memorySink();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = createLogger().set({ status: 200 }).emit();

    expect(record.success).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0].success).toBe(true);
  });

  it("status 199 -> success false (below [200,400))", () => {
    const { records, sink } = memorySink();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = createLogger().set({ status: 199 }).emit();

    expect(record.success).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0].success).toBe(false);
  });

  it("status 500 -> success false", () => {
    const { records, sink } = memorySink();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = createLogger().set({ status: 500 }).emit();

    expect(record.success).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0].success).toBe(false);
  });

  it("status 399 -> success true", () => {
    const { records, sink } = memorySink();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = createLogger().set({ status: 399 }).emit();

    expect(record.success).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0].success).toBe(true);
  });

  it("status 400 -> success false", () => {
    const { records, sink } = memorySink();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = createLogger().set({ status: 400 }).emit();

    expect(record.success).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0].success).toBe(false);
  });

  it('status "ok" -> success true', () => {
    const { records, sink } = memorySink();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = createLogger().set({ status: "ok" }).emit();

    expect(record.success).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0].success).toBe(true);
  });

  it('status "OK" -> success false (only exact "ok" is true)', () => {
    const { records, sink } = memorySink();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = createLogger().set({ status: "OK" }).emit();

    expect(record.success).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0].success).toBe(false);
  });

  it('status "500" -> success false (numeric string)', () => {
    const { records, sink } = memorySink();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = createLogger().set({ status: "500" }).emit();

    expect(record.success).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0].success).toBe(false);
  });

  it('status "200" -> success true (numeric string)', () => {
    const { records, sink } = memorySink();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = createLogger().set({ status: "200" }).emit();

    expect(record.success).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0].success).toBe(true);
  });

  it('status "399" -> success true (numeric string, upper bound inclusive of [200,400))', () => {
    const { records, sink } = memorySink();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = createLogger().set({ status: "399" }).emit();

    expect(record.success).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0].success).toBe(true);
  });

  it('status "400" -> success false (numeric string, exclusive upper bound of [200,400))', () => {
    const { records, sink } = memorySink();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = createLogger().set({ status: "400" }).emit();

    expect(record.success).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0].success).toBe(false);
  });

  it('status "199" -> success false (numeric string below 200)', () => {
    const { records, sink } = memorySink();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = createLogger().set({ status: "199" }).emit();

    expect(record.success).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0].success).toBe(false);
  });

  it('status "fail" -> success false (non-ok non-numeric string)', () => {
    const { records, sink } = memorySink();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = createLogger().set({ status: "fail" }).emit();

    expect(record.success).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0].success).toBe(false);
  });

  it("explicit success: false wins over status 200", () => {
    const { records, sink } = memorySink();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = createLogger().set({ status: 200, success: false }).emit();

    expect(record.success).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0].success).toBe(false);
  });

  it("explicit success: true wins over status 500", () => {
    const { records, sink } = memorySink();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = createLogger().set({ status: 500, success: true }).emit();

    expect(record.success).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0].success).toBe(true);
  });

  it("no status and no explicit success -> success omitted", () => {
    const { records, sink } = memorySink();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = createLogger().emit();

    expect(record.success).toBeUndefined();
    expect(records).toHaveLength(1);
    expect(records[0].success).toBeUndefined();
  });
});
