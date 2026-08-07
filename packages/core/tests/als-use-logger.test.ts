import { describe, it, expect, beforeEach } from "vitest";
import {
  createLogger,
  init,
  resetConfigForTests,
  runWithLogger,
  useLogger,
} from "../src/index.js";
import type { LogRecord, Sink } from "../src/index.js";

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

describe("ALS useLogger", () => {
  it("async runWithLogger: set via useLogger and emit reaches memory sink", async () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    await runWithLogger(createLogger(), async () => {
      useLogger()?.set({ a: 1 });
      useLogger()?.emit();
    });

    expect(records).toHaveLength(1);
    expect(records[0]!.a).toBe(1);
  });

  it("useLogger() outside runWithLogger returns undefined", () => {
    expect(useLogger()).toBeUndefined();
  });

  it("nested runWithLogger restores outer logger after inner exits", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const outer = createLogger({ scope: "A" });
    const inner = createLogger({ scope: "B" });

    runWithLogger(outer, () => {
      expect(useLogger()).toBe(outer);

      runWithLogger(inner, () => {
        expect(useLogger()).toBe(inner);
        useLogger()?.set({ from: "inner" }).emit();
      });

      expect(useLogger()).toBe(outer);
    });

    expect(useLogger()).toBeUndefined();
    expect(records).toHaveLength(1);
    expect(records[0]!.scope).toBe("B");
    expect(records[0]!.from).toBe("inner");
  });
});
