import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, init, resetConfigForTests, type LogRecord, type Sink } from "../src/index.js";

beforeEach(() => {
  resetConfigForTests();
});

describe("async sink", () => {
  it("sync emit with async sink that resolves — eventually called", async () => {
    const records: LogRecord[] = [];
    const sink: Sink = async (record) => {
      records.push(record);
    };
    init({ service: "api", env: "test", sinks: [sink] });

    createLogger().set({ route: "/health" }).emit();

    await vi.waitFor(() => {
      expect(records).toHaveLength(1);
    });
    expect(records[0]?.route).toBe("/health");
  });

  it("async sink that rejects — emit() does not throw; no unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const sink: Sink = async () => {
        throw new Error("sink failed");
      };
      init({ service: "api", env: "test", sinks: [sink] });

      expect(() => createLogger().emit()).not.toThrow();

      await vi.waitFor(() => {
        expect(unhandled).toHaveLength(0);
      });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("async sink that rejects — later sync memory sink still receives record; emit does not throw; no unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const records: LogRecord[] = [];
      const failingAsync: Sink = async () => {
        throw new Error("async sink failed");
      };
      const memory: Sink = (record) => {
        records.push(record);
      };
      init({ service: "api", env: "test", sinks: [failingAsync, memory] });

      let record: LogRecord | undefined;
      expect(() => {
        record = createLogger().set({ route: "/health" }).emit();
      }).not.toThrow();

      expect(records).toHaveLength(1);
      expect(records[0]).toBe(record);
      expect(records[0]?.route).toBe("/health");

      await vi.waitFor(() => {
        expect(unhandled).toHaveLength(0);
      });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
