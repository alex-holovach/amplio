import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import {
  createError,
  createLogger,
  logger,
  createRequestLogger,
  deepMerge,
  defineEvent,
  init,
  redactRecord,
  resetConfigForTests,
  runWithLogger,
  shouldSample,
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

describe("init", () => {
  it("requires service, env, and sinks", () => {
    expect(() => init({ service: "", env: "dev", sinks: [() => {}] })).toThrow(/service/);
    expect(() => init({ service: "api", env: "", sinks: [() => {}] })).toThrow(/env/);
    expect(() => init({ service: "api", env: "dev", sinks: [] })).toThrow(/sink/);
  });
});

describe("createLogger", () => {
  it("set returns the same logger instance (chaining identity)", () => {
    const log = createLogger();
    expect(log.set({ a: 1 })).toBe(log);
    expect(log.set({ b: 2 })).toBe(log);
  });

  it("set deep-merges and emit seals", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const base = createLogger({ feature: "checkout" });
    const next = base.set({ user_id: "u_1", nested: { a: 1 } });
    const merged = next.set({ nested: { b: 2 } });

    expect(next).toBe(base);
    expect(merged).toBe(base);
    expect(base.sealed).toBe(false);
    expect(merged.sealed).toBe(false);

    const record = merged.set({ status: 200 }).emit();

    expect(merged.sealed).toBe(true);
    expect(merged.set({ x: 1 })).toBe(merged);
    expect(merged.emit()).toBeNull();

    expect(record.service).toBe("api");
    expect(record.env).toBe("test");
    expect(record.feature).toBe("checkout");
    expect(record.user_id).toBe("u_1");
    expect(record.nested).toEqual({ a: 1, b: 2 });
    expect(record.status).toBe(200);
    expect(record.success).toBe(true);
    expect(typeof record.timestamp).toBe("string");
    expect(typeof record.duration_ms).toBe("number");
    expect(records).toHaveLength(1);
  });

  it("create() forks context", () => {
    const { sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const parent = createLogger({ request_id: "req_parent" });
    const child = parent.create({ route: "child" }).set({ status: 201 }).emit();

    expect(child.request_id).toBe("req_parent");
    expect(child.route).toBe("child");
    expect(child.status).toBe(201);
    expect(parent.sealed).toBe(false);
  });
});

describe("defineEvent + logger.event", () => {
  it("validates with zod", () => {
    const { sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const signedUp = defineEvent("auth.user.signed_up", z.object({ user_id: z.string() }));

    const record = createLogger()
      .event(signedUp)
      .set({ user_id: "u_123" })
      .emit();

    expect(record.event).toBe("auth.user.signed_up");
    expect(record.user_id).toBe("u_123");
  });

  it("supports skipValidation", () => {
    const { sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const loose = defineEvent("test.loose", z.object({ user_id: z.string() }), { skipValidation: true });

    const record = createLogger().event(loose).set({ user_id: 123 }).emit();
    expect(record.user_id).toBe(123);
  });

  it("supports Standard Schema", () => {
    const { sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const shape = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate(value: unknown) {
          if (typeof value === "object" && value !== null && "ok" in value) {
            return { value: value as { ok: boolean } };
          }
          return { issues: [{ message: "missing ok" }] };
        },
      },
    };

    const evt = defineEvent("standard.test", shape);
    const record = createLogger().event(evt).set({ ok: true }).emit();
    expect(record.ok).toBe(true);
  });
});

describe("context", () => {
  it("runWithLogger + useLogger", () => {
    const { sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const logger = createLogger({ request_id: "ctx" });
    const seen = runWithLogger(logger, () => useLogger());

    expect(seen).toBe(logger);
    expect(useLogger().sealed).toBe(true);
  });

  it("runWithLogger + useLogger sees set() mutations", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const requestLogger = createLogger({ request_id: "req_mut" });

    runWithLogger(requestLogger, () => {
      const active = useLogger();
      expect(active).toBe(requestLogger);

      active.set({ user_id: "u_als" });
      expect(useLogger()).toBe(requestLogger);
    });

    const record = requestLogger.set({ status: 200 }).emit();
    expect(record.user_id).toBe("u_als");
    expect(record.request_id).toBe("req_mut");
    expect(records).toHaveLength(1);
  });

  it("ALS middleware-style: handler set() visible to useLogger()", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const requestLogger = createRequestLogger({ method: "GET", path: "/items" });

    runWithLogger(requestLogger, () => {
      requestLogger.set({ route: { name: "list_items" } });

      const active = useLogger();
      expect(active).toBe(requestLogger);

      active.set({ user_id: "u_mw" });
    });

    const record = requestLogger.set({ status: 200 }).emit();
    expect(record.route).toEqual({ name: "list_items" });
    expect(record.user_id).toBe("u_mw");
    expect(records).toHaveLength(1);
  });
});

describe("createRequestLogger", () => {
  it("adds method, path, request_id", () => {
    const { sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = createRequestLogger({ method: "GET", path: "/health", requestId: "req_fixed" })
      .set({ status: 200 })
      .emit();

    expect(record.method).toBe("GET");
    expect(record.path).toBe("/health");
    expect(record.request_id).toBe("req_fixed");
  });
});

describe("sampling", () => {
  it("drops by head rate", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink], sampling: { rate: 0 } });

    createLogger({ request_id: "drop" }).emit();
    expect(records).toHaveLength(0);
  });

  it("emit returns finalized record when sampling drops delivery", () => {
    const { records, sink: mem } = capture();
    init({ service: "api", env: "test", sinks: [mem], sampling: { rate: 0 } });
    const record = createLogger().set({ step: "x" }).emit();
    expect(record).not.toBeNull();
    expect(record.service).toBe("api");
    expect(record.step).toBe("x");
    expect(records).toHaveLength(0);
  });

  it("enrichers still run when sampling drops sink delivery", () => {
    const { records, sink: mem } = capture();
    init({
      service: "api",
      env: "test",
      sinks: [mem],
      sampling: { rate: 0 },
      enrichers: [() => ({ tagged: true })],
    });
    const record = createLogger().emit();
    expect(record?.tagged).toBe(true);
    expect(records).toHaveLength(0);
  });

  it("redacts returned emit() record when sampling drops sinks", () => {
    const { records, sink: mem } = capture();
    // redact default on — sink empty, returned record still redacted
    init({ service: "api", env: "test", sinks: [mem], sampling: { rate: 0 } });
    const record = createLogger().set({ email: "a@b.com" }).emit();
    expect(record?.email).toBe("[REDACTED]");
    expect(records).toHaveLength(0);
  });

  it("keeps severity equals at rate 0", () => {
    const { records, sink } = capture();
    init({
      service: "api",
      env: "test",
      sinks: [sink],
      sampling: { rate: 0, keep: [{ field: "severity", equals: "ERROR" }] },
    });

    createLogger({ severity: "ERROR", request_id: "keep" }).emit();
    createLogger({ severity: "INFO", request_id: "drop" }).emit();

    expect(records).toHaveLength(1);
    expect(records[0]?.severity).toBe("ERROR");
  });

  it("keeps path matches at rate 0", () => {
    const { records, sink } = capture();
    init({
      service: "api",
      env: "test",
      sinks: [sink],
      sampling: { rate: 0, keep: [{ field: "path", matches: /^\/admin/ }] },
    });

    createLogger({ path: "/admin/users", request_id: "keep" }).emit();
    createLogger({ path: "/public", request_id: "drop" }).emit();

    expect(records).toHaveLength(1);
    expect(records[0]?.path).toBe("/admin/users");
  });

  it("keeps status gte at rate 0", () => {
    const { records, sink } = capture();
    init({
      service: "api",
      env: "test",
      sinks: [sink],
      sampling: { rate: 0, keep: [{ field: "status", gte: 500 }] },
    });

    createLogger({ status: 503, request_id: "keep" }).emit();
    createLogger({ status: 200, request_id: "drop" }).emit();

    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe(503);
  });

  it("keeps status lte at rate 0", () => {
    const { records, sink } = capture();
    init({
      service: "api",
      env: "test",
      sinks: [sink],
      sampling: { rate: 0, keep: [{ field: "status", lte: 299 }] },
    });

    createLogger({ status: 200, request_id: "keep" }).emit();
    createLogger({ status: 500, request_id: "drop" }).emit();

    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe(200);
  });

  it("keeps dotted user.plan equals at rate 0", () => {
    const { records, sink } = capture();
    init({
      service: "api",
      env: "test",
      sinks: [sink],
      sampling: { rate: 0, keep: [{ field: "user.plan", equals: "enterprise" }] },
    });

    createLogger({ user: { plan: "enterprise" }, request_id: "keep" }).emit();
    createLogger({ user: { plan: "free" }, request_id: "drop" }).emit();

    expect(records).toHaveLength(1);
    expect((records[0]?.user as { plan?: string })?.plan).toBe("enterprise");
  });
});

describe("redaction", () => {
  it("redacts sensitive values", () => {
    const redacted = redactRecord({
      email: "user@example.com",
      authorization: "Bearer secret-token",
      note: "contact me at user@example.com",
      card: "4111111111111111",
    });

    expect(redacted.email).toBe("[REDACTED]");
    expect(redacted.authorization).toBe("[REDACTED]");
    expect(redacted.note).toBe("contact me at [REDACTED]");
    expect(redacted.card).toBe("[REDACTED]");
  });

  it("redacts on emit through pipeline", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    createLogger({ authorization: "Bearer abc.def.ghi" }).emit();
    expect(records[0]?.authorization).toBe("[REDACTED]");
  });
});

describe("createError", () => {
  it("builds structured errors", () => {
    const err = createError({
      message: "Invalid token",
      why: "Token expired",
      fix: "Refresh session",
      code: "AUTH_EXPIRED",
      link: "https://docs.example/auth",
    });

    expect(err).toEqual({
      message: "Invalid token",
      why: "Token expired",
      fix: "Refresh session",
      code: "AUTH_EXPIRED",
      link: "https://docs.example/auth",
    });
  });
});

describe("deepMerge", () => {
  it("merges nested objects without mutating base", () => {
    const base = { a: 1, nested: { x: 1, y: 2 } };
    const patch = { nested: { y: 3, z: 4 } };
    const merged = deepMerge(base, patch);

    expect(base.nested).toEqual({ x: 1, y: 2 });
    expect(merged).toEqual({ a: 1, nested: { x: 1, y: 3, z: 4 } });
  });

  it("returns same reference when unchanged", () => {
    const base = { a: 1 };
    expect(deepMerge(base, {})).toBe(base);
  });
});

describe("sink pipeline", () => {
  it("runs sinks in order", () => {
    const order: number[] = [];
    init({
      service: "api",
      env: "test",
      sinks: [
        () => {
          order.push(1);
        },
        () => {
          order.push(2);
        },
      ],
    });

    createLogger().emit();
    expect(order).toEqual([1, 2]);
  });

  it("supports async sinks", async () => {
    const spy = vi.fn();
    init({
      service: "api",
      env: "test",
      sinks: [
        async () => {
          await Promise.resolve();
          spy();
        },
      ],
    });

    createLogger().emit();
    await Promise.resolve();
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe("shouldSample", () => {
  it("is deterministic for same record", () => {
    const record = { event: "x", request_id: "r1", timestamp: "t" } as LogRecord;
    const first = shouldSample(record, { rate: 0.5 });
    const second = shouldSample(record, { rate: 0.5 });
    expect(first).toBe(second);
  });
});
describe("logger facade", () => {
  it("logger.create delegates to createLogger", () => {
    const { sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const record = logger
      .create({ request_id: "facade_create" })
      .set({ status: 200 })
      .emit();

    expect(record.request_id).toBe("facade_create");
    expect(record.status).toBe(200);
  });

  it("logger.event binds schema and accepts initial context", () => {
    const { records, sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const signedUp = defineEvent("auth.user.signed_up", z.object({ user_id: z.string() }));

    const record = logger
      .event(signedUp, { user_id: "u_facade" })
      .emit();

    expect(record.event).toBe("auth.user.signed_up");
    expect(record.user_id).toBe("u_facade");
    expect(records).toHaveLength(1);
  });
});

