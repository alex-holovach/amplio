import { beforeEach, describe, expect, it } from "vitest";
import { createRequestLogger, init, resetConfigForTests, type LogRecord, type Sink } from "../src/index.js";

beforeEach(() => {
  resetConfigForTests();
});

describe("request id", () => {
  it("createRequestLogger({ method, path }) emit includes method, path, request_id", () => {
    const records: LogRecord[] = [];
    const sink: Sink = (record) => {
      records.push(record);
    };

    init({ service: "api", env: "test", sinks: [sink] });

    const record = createRequestLogger({ method: "POST", path: "/users" })
      .set({ status: 201 })
      .emit();

    expect(records).toHaveLength(1);
    expect(record.method).toBe("POST");
    expect(record.path).toBe("/users");
    expect(record.request_id).toBeDefined();
    expect(typeof record.request_id).toBe("string");
    expect(record.request_id!.length).toBeGreaterThan(0);
  });

  it("createRequestLogger({ method, path, requestId }) emit preserves that request_id", () => {
    const records: LogRecord[] = [];
    const sink: Sink = (record) => {
      records.push(record);
    };

    init({ service: "api", env: "test", sinks: [sink] });
    const record = createRequestLogger({
      method: "GET",
      path: "/x",
      requestId: "custom-id",
    }).emit();
    expect(record?.request_id).toBe("custom-id");
    expect(record?.method).toBe("GET");
    expect(record?.path).toBe("/x");
  });

  it("two loggers get different request_ids", () => {
    const records: LogRecord[] = [];
    const sink: Sink = (record) => {
      records.push(record);
    };

    init({ service: "api", env: "test", sinks: [sink] });

    const first = createRequestLogger({ method: "GET", path: "/a" }).set({ status: 200 }).emit();
    const second = createRequestLogger({ method: "GET", path: "/b" }).set({ status: 200 }).emit();

    expect(first.request_id).toBeDefined();
    expect(second.request_id).toBeDefined();
    expect(first.request_id).not.toBe(second.request_id);
  });

  it("duration_ms >= 0 on emit", () => {
    const records: LogRecord[] = [];
    const sink: Sink = (record) => {
      records.push(record);
    };

    init({ service: "api", env: "test", sinks: [sink] });

    const record = createRequestLogger({ method: "GET", path: "/health" })
      .set({ status: 200 })
      .emit();

    expect(typeof record.duration_ms).toBe("number");
    expect(record.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("duration_ms increases after a short wait before emit", async () => {
    const records: LogRecord[] = [];
    const sink: Sink = (record) => {
      records.push(record);
    };

    init({ service: "api", env: "test", sinks: [sink] });

    const logger = createRequestLogger({ method: "GET", path: "/health" }).set({ status: 200 });
    await new Promise((r) => setTimeout(r, 15));
    const record = logger.emit();

    expect(records).toHaveLength(1);
    expect(typeof record.duration_ms).toBe("number");
    expect(record.duration_ms).toBeGreaterThanOrEqual(10);
  });
});
