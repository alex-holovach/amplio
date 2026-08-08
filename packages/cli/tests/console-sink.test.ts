import type { LogRecord } from "@amplio/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consoleSink } from "../../../registry/sinks/console.ts";

describe("consoleSink", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs JSON.stringify(record) via console.log once", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const record: LogRecord = { event: "test.console", service: "console-sink" };

    consoleSink(record);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(record));
  });
  it("logs JSON.stringify for each record on two sink calls", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const first: LogRecord = { event: "test.first", service: "console-sink" };
    const second: LogRecord = { event: "test.second", service: "console-sink" };

    consoleSink(first);
    consoleSink(second);

    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenNthCalledWith(1, JSON.stringify(first));
    expect(logSpy).toHaveBeenNthCalledWith(2, JSON.stringify(second));
  });
});
