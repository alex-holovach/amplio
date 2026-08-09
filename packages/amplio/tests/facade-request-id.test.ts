import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createRequestLogger,
  defineEvent,
  init,
  logger,
  resetConfigForTests,
  runWithLogger,
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

describe("logger.event() request_id correlation", () => {
  it("copies request_id from ambient logger inside runWithLogger", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const requestLogger = createRequestLogger({
      method: "GET",
      path: "/items",
      requestId: "req_ambient",
    });

    const def = defineEvent("commerce.item.viewed", z.object({ item_id: z.string() }));

    runWithLogger(requestLogger, () => {
      logger.event(def).set({ item_id: "item_42" }).emit();
    });

    expect(records).toHaveLength(1);
    expect(records[0].request_id).toBe("req_ambient");
    expect(records[0].http).toBeUndefined();
    expect(records[0].item_id).toBe("item_42");
  });

  it("does not add request_id outside request scope", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const def = defineEvent("ops.job.started", z.object({ job_id: z.string() }));

    logger.event(def).set({ job_id: "job_1" }).emit();

    expect(records).toHaveLength(1);
    expect(records[0].request_id).toBeUndefined();
  });
});
