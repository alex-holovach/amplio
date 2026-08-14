import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  flush,
  init,
  resetConfigForTests,
  type LogRecord,
  type Sink,
} from "../src/legacy.js";

beforeEach(() => {
  resetConfigForTests();
});

describe("flush", () => {
  it("awaits a slow async sink before returning", async () => {
    const records: LogRecord[] = [];
    let resolveSink: (() => void) | undefined;
    const sink: Sink = () =>
      new Promise<void>((resolve) => {
        resolveSink = resolve;
      }).then(() => {
        records.push({
          service: "api",
          env: "test",
          timestamp: "",
          duration_ms: 0,
          ok: true,
        });
      });

    init({ service: "api", env: "test", sinks: [sink] });
    createLogger().set({ ok: true }).emit();

    expect(records).toHaveLength(0);

    resolveSink?.();
    await flush();

    expect(records).toHaveLength(1);
  });

  it("clears pending after flush completes", async () => {
    const records: LogRecord[] = [];
    const sink: Sink = async (record) => {
      records.push(record);
    };
    init({ service: "api", env: "test", sinks: [sink] });

    createLogger().set({ route: "/health" }).emit();
    await flush();
    await flush();

    expect(records).toHaveLength(1);
  });

  it("invokes flushable sink hooks and then awaits pending delivery", async () => {
    const order: string[] = [];
    let releaseDelivery!: () => void;
    const sink = (() =>
      new Promise<void>((resolve) => {
        releaseDelivery = () => {
          order.push("delivery");
          resolve();
        };
      })) as Sink;
    sink.flush = async () => {
      order.push("flush-start");
      releaseDelivery();
      await Promise.resolve();
      order.push("flush-end");
    };
    init({ service: "api", env: "test", sinks: [sink] });
    createLogger().emit();

    await flush();

    expect(order).toEqual(["flush-start", "delivery", "flush-end"]);
  });

  it("is safe before init", async () => {
    await expect(flush()).resolves.toBeUndefined();
  });

  it("tracks a PromiseLike sink result until flush", async () => {
    let settle!: () => void;
    let settled = false;
    const sink = (() => ({
      then(resolve: () => void) {
        settle = () => {
          settled = true;
          resolve();
        };
      },
    })) as unknown as Sink;
    init({ service: "api", env: "test", sinks: [sink] });
    createLogger().emit();

    const flushing = flush();
    await Promise.resolve();
    expect(settled).toBe(false);
    settle();
    await flushing;

    expect(settled).toBe(true);
  });

  it("warns in development when an async sink rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sink: Sink = async () => {
      throw new Error("sink failed");
    };
    init({ service: "api", env: "test", sinks: [sink] });

    createLogger().emit();
    await flush();

    expect(warn).toHaveBeenCalledWith("[amplio] sink_failed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("sink failed");
    warn.mockRestore();
  });

  it("isolates a failing flush hook and continues to later sinks", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new Error("flush failed");
    const first = (() => undefined) as Sink;
    first.flush = () => {
      throw failure;
    };
    const second = (() => undefined) as Sink;
    const next = vi.fn();
    second.flush = next;
    init({ service: "api", env: "test", sinks: [first, second] });

    await expect(flush()).resolves.toBeUndefined();

    expect(next).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(failure.message);
  });
});
