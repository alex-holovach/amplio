import { event, init, type SinkRecord } from "@useamplio/amplio";
import { resetConfigForTests } from "@useamplio/amplio/legacy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { consoleSink } from "../../../registry/sinks/console.ts";

const record = (eventId: string, extra: Record<string, unknown> = {}) =>
  ({
    "@event": eventId,
    "@event_version": 1,
    service: "console-sink",
    env: "test",
    timestamp: "2026-08-14T00:00:00.000Z",
    duration_ms: 0,
    success: true,
    ...extra,
  }) as unknown as SinkRecord;

describe("consoleSink", () => {
  beforeEach(resetConfigForTests);
  afterEach(() => vi.restoreAllMocks());

  it("logs one canonical Event record per call", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const first = record("test.first");
    const second = record("test.second");
    consoleSink(first);
    consoleSink(second);
    expect(log).toHaveBeenNthCalledWith(1, JSON.stringify(first));
    expect(log).toHaveBeenNthCalledWith(2, JSON.stringify(second));
  });

  it("serializes BigInt and cycles without throwing through application work", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const unsafe = record("test.unsafe_values", {
      count: 9_007_199_254_740_993n,
    }) as unknown as SinkRecord & { self?: unknown };
    unsafe.self = unsafe;
    expect(() => consoleSink(unsafe)).not.toThrow();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      "@event": "test.unsafe_values",
      count: "9007199254740993",
      self: "[Circular]",
    });
  });

  it("delivers a root Event while preserving exact application result identity", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    init({
      service: "console-test",
      env: "test",
      redact: false,
      sinks: [consoleSink],
    });
    const Delivery = event({
      id: "console.semantic_delivery",
      version: 1,
      schema: z.object({ payload: z.any() }),
    });
    const payload: Record<string, unknown> = { count: 42n };
    payload.self = payload;
    const run = Delivery.handle(() => payload, {
      result: ({ result }) => ({ payload: result }),
    });

    expect(run()).toBe(payload);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      "@event": "console.semantic_delivery",
      payload: { count: "42", self: "[Circular]" },
      success: true,
    });
  });
});
