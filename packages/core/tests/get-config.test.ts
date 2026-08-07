import { beforeEach, describe, expect, it } from "vitest";
import {
  createLogger,
  getConfig,
  init,
  resetConfigForTests,
  type Enricher,
  type LogRecord,
  type Sink,
} from "../src/index.js";

beforeEach(() => {
  resetConfigForTests();
});

describe("getConfig", () => {
  it("throws before init", () => {
    expect(() => getConfig()).toThrow(/logcn is not initialized/);
  });

  it("returns service, env, and sinks after init", () => {
    const sinks = [() => {}, () => {}];
    init({ service: "api", env: "prod", sinks });

    const config = getConfig();
    expect(config.service).toBe("api");
    expect(config.env).toBe("prod");
    expect(config.sinks).toHaveLength(2);
  });

  it("getConfig().sinks is a defensive copy", () => {
    const records: LogRecord[] = [];
    const mem: Sink = (record) => {
      records.push(record);
    };
    init({ service: "api", env: "test", sinks: [mem] });

    const sinks = getConfig().sinks;
    sinks.push(() => {});

    expect(getConfig().sinks).toHaveLength(1);
    createLogger().emit();
    expect(records).toHaveLength(1);
  });

  it("init() copies sinks (caller mutate after init is ignored)", () => {
    const records: LogRecord[] = [];
    const mem: Sink = (record) => {
      records.push(record);
    };
    const sinks = [mem];
    init({ service: "api", env: "test", sinks });

    const leaked: LogRecord[] = [];
    sinks.push((r) => {
      leaked.push(r);
    });

    expect(getConfig().sinks).toHaveLength(1);
    createLogger().emit();
    expect(leaked).toHaveLength(0);
    expect(records).toHaveLength(1);
  });

  it("getConfig().enrichers is a defensive copy", () => {
    const records: LogRecord[] = [];
    const mem: Sink = (record) => {
      records.push(record);
    };
    const tag: Enricher = (record) => ({ ...record, tagged: true });
    init({ service: "api", env: "test", sinks: [mem], enrichers: [tag] });

    const enrichers = getConfig().enrichers!;
    enrichers.push(() => ({ tagged: "leak" }) as any);

    expect(getConfig().enrichers).toHaveLength(1);
    const record = createLogger().emit();
    expect(record?.tagged).toBe(true);
    expect(record?.tagged).not.toBe("leak");
    expect(records[0]?.tagged).toBe(true);
    expect(records[0]?.tagged).not.toBe("leak");
  });

  it("getConfig().sampling is a defensive copy (keep array not leaked)", () => {
    const records: LogRecord[] = [];
    const mem: Sink = (record) => {
      records.push(record);
    };
    init({
      service: "api",
      env: "test",
      sinks: [mem],
      sampling: { rate: 0, keep: [{ field: "severity", equals: "ERROR" }] },
    });

    getConfig().sampling!.keep!.push({ field: "x", equals: "y" });
    getConfig().sampling!.rate = 1;

    expect(getConfig().sampling!.keep).toHaveLength(1);
    expect(getConfig().sampling!.rate).toBe(0);

    createLogger({ severity: "INFO", request_id: "drop" }).emit();
    expect(records).toHaveLength(0);

    const kept = createLogger({ severity: "ERROR", request_id: "keep" }).emit();
    expect(kept?.severity).toBe("ERROR");
    expect(records).toHaveLength(1);
  });

  it("init() copies sampling.keep (caller mutate after init is ignored)", () => {
    const records: LogRecord[] = [];
    const mem: Sink = (record) => {
      records.push(record);
    };
    const keep = [{ field: "severity", equals: "ERROR" }];
    init({ service: "api", env: "test", sinks: [mem], sampling: { rate: 0, keep } });
    keep.push({ field: "status", gte: 500 });

    expect(getConfig().sampling?.keep).toHaveLength(1);

    createLogger({ severity: "INFO", status: 503, request_id: "drop" }).emit();
    expect(records).toHaveLength(0);
  });

  it("init() copies enrichers (caller mutate after init is ignored)", () => {
    const records: LogRecord[] = [];
    const mem: Sink = (record) => {
      records.push(record);
    };
    const tag: Enricher = () => ({ tagged: true });
    const enrichers: Enricher[] = [tag];
    init({ service: "api", env: "test", sinks: [mem], enrichers });
    enrichers.push(() => ({ leaked: true }));

    expect(getConfig().enrichers).toHaveLength(1);
    const record = createLogger().emit();
    expect(record?.tagged).toBe(true);
    expect(record?.leaked).toBeUndefined();
    expect(records[0]?.tagged).toBe(true);
    expect(records[0]?.leaked).toBeUndefined();
  });

  it("stores trimmed service and env", () => {
    init({ service: "  api  ", env: "  test  ", sinks: [() => {}] });
    expect(getConfig().service).toBe("api");
    expect(getConfig().env).toBe("test");
  });

  it("emit record has trimmed service and env", () => {
    const records: LogRecord[] = [];
    const mem: Sink = (record) => {
      records.push(record);
    };
    init({ service: "  api  ", env: "  prod  ", sinks: [mem] });
    const record = createLogger().emit();
    expect(record?.service).toBe("api");
    expect(record?.env).toBe("prod");
    expect(records[0]?.service).toBe("api");
    expect(records[0]?.env).toBe("prod");
  });

  it("throws again after resetConfigForTests", () => {
    init({ service: "api", env: "test", sinks: [() => {}] });
    expect(getConfig().service).toBe("api");

    resetConfigForTests();
    expect(() => getConfig()).toThrow(/logcn is not initialized/);
  });

  it("second init replaces getConfig service (and sampling)", () => {
    init({ service: "a", env: "test", sinks: [() => {}], sampling: { rate: 0.5 } });
    expect(getConfig().service).toBe("a");
    expect(getConfig().sampling).toEqual({ rate: 0.5 });

    init({ service: "b", env: "test", sinks: [() => {}, () => {}] });
    expect(getConfig().service).toBe("b");
    expect(getConfig().sampling).toBeUndefined();
  });

  it("getConfig returns redact: false after init (cleared on second init)", () => {
    init({ service: "api", env: "test", sinks: [() => {}], redact: false });
    expect(getConfig().redact).toBe(false);

    init({ service: "api", env: "test", sinks: [() => {}] });
    expect(getConfig().redact).toBeUndefined();
  });
});
