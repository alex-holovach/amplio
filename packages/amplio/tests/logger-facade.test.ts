import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineEvent,
  init,
  logger,
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

describe("logger facade", () => {
  it("logger.create().set().emit works with memory sink", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = logger.create().set({ job: { id: "job-1" } }).emit();

    expect(records).toHaveLength(1);
    expect(records[0]).toBe(record);
    expect(record.job).toEqual({ id: "job-1" });
  });

  it("logger.event(defineEvent(...)).set().emit sets event name", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const checkout = defineEvent(
      "commerce.checkout.completed",
      z.object({ order_id: z.string() }),
    );

    const record = logger.event(checkout).set({ order_id: "ord-42" }).emit();

    expect(records).toHaveLength(1);
    expect(records[0]).toBe(record);
    expect(record.event).toBe("commerce.checkout.completed");
    expect(record.order_id).toBe("ord-42");
  });
});
