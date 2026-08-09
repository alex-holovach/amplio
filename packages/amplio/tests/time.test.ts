import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createLogger,
  defineEvent,
  getLogger,
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

const StepDone = defineEvent("ops.step.done", z.object({ step: z.string() }));

beforeEach(() => {
  resetConfigForTests();
});

describe("logger.time()", () => {
  it("emits a correlated child row timed around fn and returns fn's result", async () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const parent = createLogger({ request_id: "req_time" });

    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000);

    const result = await parent.time(StepDone, async (ev) => {
      nowSpy.mockReturnValue(1_080);
      ev.set({ step: "validate" });
      return "done";
    });

    nowSpy.mockRestore();

    expect(result).toBe("done");
    expect(records).toHaveLength(1);
    expect(records[0]?.event).toBe("ops.step.done");
    expect(records[0]?.request_id).toBe("req_time");
    expect(records[0]?.duration_ms).toBe(80);
    expect(records[0]?.step).toBe("validate");
    expect(parent.sealed).toBe(false);
  });

  it("records the error and rethrows when fn throws", async () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const parent = createLogger({ request_id: "req_time_err" });
    const def = defineEvent("ops.step.failed");

    await expect(
      parent.time(def, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(records).toHaveLength(1);
    expect(records[0]?.success).toBe(false);
    expect((records[0]?.error as { message?: string })?.message).toBe("boom");
    // A domain row's error is not an HTTP status.
    expect(records[0]?.status).toBeUndefined();
  });

  it("no-op logger (outside ALS scope) still runs fn and passes the result through", async () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const result = await getLogger().time(StepDone, async (ev) => {
      ev.set({ step: "noop" });
      return 42;
    });

    expect(result).toBe(42);
    expect(records).toHaveLength(0);
  });
});
