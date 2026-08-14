import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
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

describe("enricher errors", () => {
  it("failing enricher is skipped — later enrichers and sinks still run", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mem = memorySink();
    const boom: Enricher = () => {
      throw new Error("enricher failed");
    };
    const ok: Enricher = (record) => ({ ...record, rescued: true });

    init({
      service: "api",
      env: "test",
      sinks: [mem.sink],
      enrichers: [boom, ok],
    });

    const record = createLogger().set({ route: "/health" }).emit();

    expect(record?.route).toBe("/health");
    expect(record?.rescued).toBe(true);
    expect(mem.records).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/enricher failed/),
    );
    warn.mockRestore();
  });

  it("enricher throw does not abort emit()", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const boom: Enricher = () => {
      throw new Error("enricher failed");
    };
    init({ service: "api", env: "test", sinks: [() => {}], enrichers: [boom] });

    expect(() => createLogger().set({ ok: true }).emit()).not.toThrow();
    warn.mockRestore();
  });

  it("first enricher throws, second throws, third enricher still runs and sink receives record", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mem = memorySink();
    const firstBoom: Enricher = () => {
      throw new Error("first enricher failed");
    };
    const secondBoom: Enricher = () => {
      throw new Error("second enricher failed");
    };
    const ok: Enricher = (record) => ({ ...record, rescued: true });

    init({
      service: "api",
      env: "test",
      sinks: [mem.sink],
      enrichers: [firstBoom, secondBoom, ok],
    });

    const record = createLogger().set({ route: "/health" }).emit();

    expect(record?.route).toBe("/health");
    expect(record?.rescued).toBe(true);
    expect(mem.records).toHaveLength(1);
    expect(mem.records[0]).toBe(record);
    expect(mem.records[0]?.rescued).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/first enricher failed/),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/second enricher failed/),
    );
    warn.mockRestore();
  });

  it("non-object enricher return is ignored — prior fields kept", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mem = memorySink();
    const bad: Enricher = () => undefined as unknown as LogRecord;
    const ok: Enricher = (record) => ({ ...record, rescued: true });

    init({
      service: "api",
      env: "test",
      sinks: [mem.sink],
      enrichers: [bad, ok],
    });

    const record = createLogger().set({ route: "/health" }).emit();

    expect(record?.route).toBe("/health");
    expect(record?.rescued).toBe(true);
    expect(mem.records).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/must return a plain object/),
    );
    warn.mockRestore();
  });

  it("enricher null/string/array returns are ignored — later enrichers and sinks still run", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mem = memorySink();
    const badNull: Enricher = () => null as unknown as LogRecord;
    const badString: Enricher = () => "oops" as unknown as LogRecord;
    const badArray: Enricher = () => [{ x: 1 }] as unknown as LogRecord;
    const ok: Enricher = (record) => ({ ...record, rescued: true });

    init({
      service: "api",
      env: "test",
      sinks: [mem.sink],
      enrichers: [badNull, badString, badArray, ok],
    });

    const record = createLogger().set({ route: "/health", kept: 1 }).emit();

    expect(record?.route).toBe("/health");
    expect(record?.kept).toBe(1);
    expect(record?.rescued).toBe(true);
    expect(mem.records).toHaveLength(1);
    expect(mem.records[0]).toBe(record);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/must return a plain object/),
    );
    warn.mockRestore();
  });
});

