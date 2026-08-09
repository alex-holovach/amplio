import { beforeEach, describe, expect, it } from "vitest";
import { createRequestLogger, init, resetConfigForTests, type LogRecord, type Sink } from "../src/index.js";

beforeEach(() => {
  resetConfigForTests();
});

describe("request logger smoke", () => {
  it("createRequestLogger emits route context to a memory sink", () => {
    const records: LogRecord[] = [];
    const sink: Sink = (record) => {
      records.push(record);
    };

    init({ service: "smoke", env: "test", sinks: [sink] });

    const record = createRequestLogger({ method: "GET", path: "/health" })
      .set({ route: { name: "health" }, status: 200 })
      .emit();

    expect(records).toHaveLength(1);
    expect(records[0]).toBe(record);
    expect(record.service).toBe("smoke");
    expect(record.http).toEqual({ method: "GET", path: "/health" });
    expect(record.method).toBeUndefined();
    expect(record.path).toBeUndefined();
    expect(record.route).toEqual({ name: "health" });
    expect(record.status).toBe(200);
  });
});
