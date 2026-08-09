import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createLogger,
  createRequestLogger,
  defineEvent,
  init,
  resetConfigForTests,
  type LogRecord,
  type Sink,
} from "../src/index.js";

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

describe("logger.child()", () => {
  it("copies request_id only — no http or other parent fields", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const parent = createRequestLogger({ method: "GET", path: "/items", requestId: "req_child" });
    parent.set({ route: { name: "list_items" }, trpc: { path: "items.list" } });

    const childDef = defineEvent("commerce.item.viewed", z.object({ item_id: z.string() }));
    const childRecord = parent.child(childDef).set({ item_id: "item_1" }).emit();

    expect(childRecord?.request_id).toBe("req_child");
    expect(childRecord?.http).toBeUndefined();
    expect(childRecord?.trpc).toBeUndefined();
    expect(childRecord?.route).toBeUndefined();
    expect(childRecord?.event).toBe("commerce.item.viewed");
    expect(records).toHaveLength(1);
  });

  it("emitting child does not seal parent — parent can still emit its row", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const parent = createRequestLogger({ method: "POST", path: "/checkout", requestId: "req_dual" });
    const childDef = defineEvent("commerce.checkout.started", z.object({ cart_id: z.string() }));

    parent.child(childDef).set({ cart_id: "cart_1" }).emit();

    expect(parent.sealed).toBe(false);

    const parentRecord = parent.set({ status: 200 }).emit();

    expect(parent.sealed).toBe(true);
    expect(parentRecord?.event).toBe("http.request");
    expect(records).toHaveLength(2);
    expect(records[0].event).toBe("commerce.checkout.started");
    expect(records[1].event).toBe("http.request");
  });

  it("child duration_ms uses a fresh start time, not the request elapsed time", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValueOnce(1_000);
    const parent = createLogger({ request_id: "req_duration" });

    nowSpy.mockReturnValueOnce(1_000);
    const childDef = defineEvent("ops.step.done", z.object({ step: z.string() }));
    const child = parent.child(childDef);

    nowSpy.mockReturnValueOnce(1_050);
    child.set({ step: "validate" }).emit();

    expect(records[0]?.duration_ms).toBe(50);

    nowSpy.mockRestore();
  });

  it("child of a sealed parent still emits", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const parent = createRequestLogger({ method: "GET", path: "/health", requestId: "req_sealed" });
    parent.set({ status: 200 }).emit();
    expect(parent.sealed).toBe(true);

    const childDef = defineEvent("ops.after.request", z.object({ note: z.string() }));
    const childRecord = parent.child(childDef).set({ note: "late work" }).emit();

    expect(childRecord?.request_id).toBe("req_sealed");
    expect(childRecord?.event).toBe("ops.after.request");
    expect(records).toHaveLength(2);
  });

  it("child validates against def shape", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink], strict: true });

    const parent = createLogger({ request_id: "req_validate" });
    const childDef = defineEvent(
      "auth.user.signed_up",
      z.object({ user: z.object({ id: z.string() }) }),
    );

    const childRecord = parent.child(childDef).set({ user: { id: "u_1" } }).emit();

    expect(childRecord?.user).toEqual({ id: "u_1" });
    expect(records).toHaveLength(1);
  });
});
