import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  init,
  logger,
  resetConfigForTests,
  type LogRecord,
  type Sink,
} from "../src/legacy.js";

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

describe("logger.create() fork", () => {
  it("logger.create().set() returns the same child instance", () => {
    const { sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });
    const child = logger.create();
    expect(child.set({ a: 1 })).toBe(child);
    expect(child.set({ b: 2 })).toBe(child);
  });

  it("createLogger().set nested patches keep siblings on emit", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = createLogger()
      .set({ user: { id: "1", plan: "free" } })
      .set({ user: { plan: "pro" } })
      .emit();

    expect(record.user).toEqual({ id: "1", plan: "pro" });
    expect(records).toHaveLength(1);
  });

  it("createLogger().set null overwrites nested value and keeps siblings on emit", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = createLogger()
      .set({ user: { id: "u1", plan: "pro" } })
      .set({ user: { plan: null } })
      .emit();

    expect(record?.user).toEqual({ id: "u1", plan: null });
    expect(records).toHaveLength(1);
  });

  it("inherits parent context via deep merge", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const parent = createLogger({
      request_id: "req_parent",
      user: { id: "u_1" },
    });

    const child = parent.create({ child: true, user: { plan: "pro" } });
    const childRecord = child.set({ status: 201 }).emit();

    expect(childRecord.request_id).toBe("req_parent");
    expect(childRecord.child).toBe(true);
    expect(childRecord.user).toEqual({ id: "u_1", plan: "pro" });
    expect(childRecord.status).toBe(201);
    expect(records).toHaveLength(1);
  });

  it("create() uses a fresh start time for duration_ms", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValueOnce(2_000);
    const parent = createLogger({ request_id: "req_fork_duration" });

    nowSpy.mockReturnValueOnce(2_000);
    const child = parent.create({ child: true });

    nowSpy.mockReturnValueOnce(2_030);
    child.set({ status: 201 }).emit();

    expect(records[0]?.duration_ms).toBe(30);

    nowSpy.mockRestore();
  });

  it("child.emit() does not seal parent — parent can still set/emit", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const parent = createLogger({ request_id: "req_parent" });
    const child = parent.create({ child: true });

    child.set({ status: 201 }).emit();

    expect(child.sealed).toBe(true);
    expect(parent.sealed).toBe(false);

    const parentRecord = parent.set({ status: 200 }).emit();

    expect(parent.sealed).toBe(true);
    expect(parentRecord.request_id).toBe("req_parent");
    expect(parentRecord.status).toBe(200);
    expect(parentRecord.child).toBeUndefined();
    expect(records).toHaveLength(2);
    expect(records[0].child).toBe(true);
    expect(records[1].child).toBeUndefined();
  });

  it("parent.emit() seals parent only", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const parent = createLogger({ request_id: "req_parent" });
    const child = parent.create({ child: true });

    parent.set({ status: 200 }).emit();

    expect(parent.sealed).toBe(true);
    expect(child.sealed).toBe(false);
    expect(parent.set({ x: 1 })).toBe(parent);
    expect(parent.emit()).toBeNull();

    const childRecord = child.set({ status: 201 }).emit();

    expect(child.sealed).toBe(true);
    expect(childRecord.child).toBe(true);
    expect(childRecord.status).toBe(201);
    expect(records).toHaveLength(2);
  });

  it("logger.set() with undefined does NOT clear prior value (skip undefined in patch)", () => {
    const { sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });
    const record = createLogger()
      .set({ feature: "checkout", user_id: "u1" })
      .set({ feature: undefined as unknown as string })
      .emit();
    expect(record?.feature).toBe("checkout");
    expect(record?.user_id).toBe("u1");
  });

  it("logger.set() replaces arrays (does not concatenate)", () => {
    const { sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });
    const record = createLogger()
      .set({ tags: ["a", "b"] })
      .set({ tags: ["c"] })
      .emit();
    expect(record?.tags).toEqual(["c"]);
  });
});
