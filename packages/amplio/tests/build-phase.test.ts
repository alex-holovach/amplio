import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLogger,
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

beforeEach(() => {
  resetConfigForTests();
});

afterEach(() => {
  delete process.env.NEXT_PHASE;
  delete process.env.AMPLIO_DISABLED;
});

describe("Next.js build-phase tagging", () => {
  it("tags records with build_phase: true during next build prerendering", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "production", sinks: [sink] });

    process.env.NEXT_PHASE = "phase-production-build";
    const record = createLogger({ request_id: "req_build" }).emit();

    expect(record?.build_phase).toBe(true);
    expect(records[0]?.build_phase).toBe(true);
  });

  it("does not add build_phase outside the build phase", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = createLogger().emit();

    expect(record?.build_phase).toBeUndefined();
    expect(records[0]?.build_phase).toBeUndefined();
  });

  it("does not tag on other NEXT_PHASE values", () => {
    const { sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    process.env.NEXT_PHASE = "phase-development-server";
    const record = createLogger().emit();

    expect(record?.build_phase).toBeUndefined();
  });
});

describe("AMPLIO_DISABLED escape hatch", () => {
  it("drops every emit without running sinks when AMPLIO_DISABLED=1", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    process.env.AMPLIO_DISABLED = "1";
    const logger = createLogger({ request_id: "req_disabled" });
    const record = logger.emit();

    expect(record).toBeNull();
    expect(records).toHaveLength(0);
    expect(logger.sealed).toBe(true);
  });

  it('accepts "true" as well', () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    process.env.AMPLIO_DISABLED = "true";
    expect(createLogger().emit()).toBeNull();
    expect(records).toHaveLength(0);
  });

  it("other values do not disable", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    process.env.AMPLIO_DISABLED = "0";
    expect(createLogger().emit()).not.toBeNull();
    expect(records).toHaveLength(1);
  });
});
