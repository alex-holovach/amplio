import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  event,
  flush,
  init,
  type InitOptions,
  type Schema,
  type SinkRecord,
} from "../src/index.js";
import { plugin } from "../src/plugin.js";
import { init as initLegacy, resetConfigForTests } from "../src/legacy.js";

type ResourceAttributes = Readonly<Record<string, string | number | boolean>>;

type TargetDiagnostic = Readonly<{
  code: string;
  event?: string;
  stage?: string;
  [key: string]: unknown;
}>;

type TargetSink = ((record: SinkRecord) => void | PromiseLike<void>) & {
  flush?: () => void | PromiseLike<void>;
};

type TargetInitOptions = Omit<InitOptions, "sinks" | "enrichers" | "redact"> & {
  sinks: TargetSink[];
  enrichers?: Array<
    (current: ResourceAttributes) => ResourceAttributes | undefined
  >;
  redactor?: (record: SinkRecord) => unknown;
  sampler?: (record: SinkRecord) => boolean;
  onDiagnostic?: (diagnostic: TargetDiagnostic) => unknown;
  delivery?: {
    maxPendingPerSink?: number;
    flushTimeoutMs?: number;
    maxRetiredGenerations?: number;
    retiredGenerationTtlMs?: number;
  };
};

type TargetFlushResult = {
  completed: number;
  pending: number;
  failures: number;
};

const initTarget = (options: TargetInitOptions): void => {
  init(options as unknown as InitOptions);
};

const flushTarget = (options?: {
  timeoutMs?: number;
}): Promise<TargetFlushResult> =>
  (
    flush as unknown as (options?: {
      timeoutMs?: number;
    }) => Promise<TargetFlushResult>
  )(options);

const passthroughObjectSchema: Schema<
  Record<string, unknown>,
  Record<string, unknown>
> = {
  "~standard": {
    version: 1,
    vendor: "event-delivery-contract-test",
    validate(value: unknown) {
      return value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
        ? { value: value as Record<string, unknown> }
        : { issues: [{ message: "Expected an object" }] };
    },
  },
};

const deferred = <Value = void>() => {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const TIMED_OUT = Symbol("test-timeout");

const raceWithDeadline = async <Value>(
  promise: Promise<Value>,
  timeoutMs = 100,
): Promise<Value | typeof TIMED_OUT> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const collect = (overrides: Partial<TargetInitOptions> = {}): SinkRecord[] => {
  const records: SinkRecord[] = [];
  initTarget({
    service: "event-delivery-contract",
    env: "test",
    sinks: [(record) => records.push(record)],
    ...overrides,
  });
  return records;
};

beforeEach(() => {
  resetConfigForTests();
});

describe("Delivery before initialization", () => {
  it("flushes a cold runtime as an empty finite watermark", async () => {
    await expect(flushTarget({ timeoutMs: 10 })).resolves.toEqual({
      completed: 0,
      pending: 0,
      failures: 0,
    });
  });
});

describe("Event validation, sanitization, and ownership", () => {
  it("delivers the root schema's transformed output", () => {
    const TransformedRoot = event({
      id: "delivery.transformed_root",
      version: 1,
      schema: z
        .object({ raw: z.string() })
        .transform(({ raw }) => ({ normalized: raw.trim().toUpperCase() })),
    });
    const records = collect();
    const run = TransformedRoot.handle(() => "application-result", {
      input: () => ({ raw: "  ready  " }),
    });

    expect(run()).toBe("application-result");

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ normalized: "READY" });
    expect(records[0]).not.toHaveProperty("raw");
  });

  it("drops a schema-invalid root without changing application behavior", () => {
    const InvalidRoot = event({
      id: "delivery.invalid_root",
      version: 1,
      schema: z.object({ required: z.string() }),
    });
    const records = collect();
    const applicationResult = { ok: true };
    const run = InvalidRoot.handle(() => applicationResult);

    expect(run()).toBe(applicationResult);
    expect(records).toEqual([]);
  });

  it("omits a schema-invalid nested Event and records a bounded diagnostic", () => {
    const InvalidCall = event({
      id: "delivery.invalid_nested",
      version: 1,
      schema: z.object({ required: z.string() }),
      timing: "duration",
    });
    const InvalidPlugin = plugin({
      id: "delivery-invalid-nested",
      events: { calls: InvalidCall },
      instrument({ events, observe }) {
        return <F extends () => unknown>(fn: F): F => observe(events.calls, fn);
      },
    });
    const Root = event({
      id: "delivery.nested_validation_root",
      version: 1,
      schema: z.object({}),
      tree: { nested: InvalidPlugin.events },
    });
    const records = collect();
    const invalidCall = InvalidPlugin(() => "provider-result");
    const run = Root.handle(() => invalidCall());

    expect(run()).toBe("provider-result");

    expect(records).toHaveLength(1);
    expect(records[0]).not.toHaveProperty("nested");
    expect(records[0]?.["@amplio"]).toMatchObject({
      diagnostics: [
        expect.objectContaining({
          code: expect.any(String),
          path: ["nested", "calls"],
          event: "delivery.invalid_nested",
          count: 1,
        }),
      ],
    });
  });

  it("sanitizes BigInt, Date, cycles, hostile getters, and proxies while preserving safe siblings", () => {
    const SanitizedRoot = event({
      id: "delivery.hostile_values",
      version: 1,
      schema: passthroughObjectSchema,
    });
    const records = collect();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const hostile: Record<string, unknown> = { safe: "getter-sibling" };
    Object.defineProperty(hostile, "explodes", {
      enumerable: true,
      get() {
        throw new Error("hostile getter");
      },
    });
    const proxy = new Proxy(
      { hidden: "must-not-escape" },
      {
        ownKeys() {
          throw new Error("hostile proxy");
        },
      },
    );
    const date = new Date("2026-08-13T12:34:56.000Z");
    const run = SanitizedRoot.handle(() => undefined, {
      input: () => ({
        safe: "root-sibling",
        big: 9_007_199_254_740_993n,
        date,
        cycle,
        hostile,
        proxy,
      }),
    });

    expect(() => run()).not.toThrow();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      safe: "root-sibling",
      big: "9007199254740993",
      date: "2026-08-13T12:34:56.000Z",
      cycle: { self: "[Circular]" },
      hostile: { safe: "getter-sibling" },
    });
    expect(records[0]).not.toHaveProperty("proxy");
    expect(JSON.stringify(records[0])).not.toContain("must-not-escape");
    expect(Object.getPrototypeOf(records[0])).toBeNull();
    expect(Object.getPrototypeOf(records[0]?.cycle)).toBeNull();
    expect(Object.getPrototypeOf(records[0]?.hostile)).toBeNull();
  });

  it("prevents projectors and schemas from spoofing runtime, resource, or declared-tree ownership", () => {
    const RealEntry = event({
      id: "delivery.real_entry",
      version: 1,
      schema: z.object({ value: z.string() }),
      timing: "instant",
    });
    const RealPlugin = plugin({
      id: "delivery-real-entry",
      events: { entry: RealEntry },
      instrument({ events, record }) {
        return (value: string): void => record(events.entry, { value });
      },
    });
    const Root = event({
      id: "delivery.owned_fields",
      version: 7,
      schema: z.object({ semantic: z.string() }).passthrough(),
      tree: { provider: RealPlugin.events },
    });
    const records = collect({ service: "real-service", env: "real-env" });
    const run = Root.handle(
      () => {
        RealPlugin("real-child");
      },
      {
        input: () =>
          ({
            semantic: "real-semantic",
            "@event": "spoof.event",
            "@event_version": 999,
            service: "spoof-service",
            env: "spoof-env",
            timestamp: "spoof-timestamp",
            duration_ms: 999_999,
            success: false,
            error: { type: "Spoof" },
            "@amplio": { spoofed: true },
            resource: { region: "spoof-region" },
            provider: { entry: { value: "spoof-child" } },
          }) as never,
      },
    );

    run();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      "@event": "delivery.owned_fields",
      "@event_version": 7,
      service: "real-service",
      env: "real-env",
      success: true,
      semantic: "real-semantic",
      provider: { entry: { value: "real-child" } },
    });
    expect(records[0]?.timestamp).not.toBe("spoof-timestamp");
    expect(records[0]?.duration_ms).not.toBe(999_999);
    expect(records[0]).not.toHaveProperty("error");
    expect(records[0]).not.toHaveProperty("@amplio");
    expect(records[0]).not.toHaveProperty("resource");
    expect(JSON.stringify(records[0])).not.toContain("spoof-child");
  });

  it("gives every sink an isolated deeply immutable logical snapshot", () => {
    const ImmutableRoot = event({
      id: "delivery.immutable_snapshot",
      version: 1,
      schema: z.object({ payload: z.object({ value: z.string() }) }),
    });
    let firstRecord: SinkRecord | undefined;
    let secondRecord: SinkRecord | undefined;
    let mutationSucceeded = true;
    let firstWasDeeplyFrozen = false;
    const firstSink: TargetSink = (record) => {
      firstRecord = record;
      const payload = record.payload as Record<string, unknown>;
      firstWasDeeplyFrozen =
        Object.isFrozen(record) && Object.isFrozen(payload);
      try {
        mutationSucceeded = Reflect.set(payload, "value", "mutated");
      } catch {
        mutationSucceeded = false;
      }
    };
    const secondSink: TargetSink = (record) => {
      secondRecord = record;
    };
    initTarget({
      service: "event-delivery-contract",
      env: "test",
      sinks: [firstSink, secondSink],
    });
    const run = ImmutableRoot.handle(() => undefined, {
      input: () => ({ payload: { value: "original" } }),
    });

    run();

    expect(firstRecord).toBeDefined();
    expect(secondRecord).toBeDefined();
    expect(firstWasDeeplyFrozen).toBe(true);
    expect(mutationSucceeded).toBe(false);
    expect(firstRecord).not.toBe(secondRecord);
    expect(secondRecord).toMatchObject({ payload: { value: "original" } });
    expect(Object.isFrozen(secondRecord)).toBe(true);
    expect(
      Object.isFrozen(secondRecord?.payload as Record<string, unknown>),
    ).toBe(true);
  });

  it("enforces configured UTF-8 string, key, and depth limits", () => {
    const BoundedRoot = event({
      id: "delivery.semantic_bounds",
      version: 1,
      schema: passthroughObjectSchema,
    });
    const records = collect({
      limits: { maxStringBytes: 5, maxKeys: 3, maxDepth: 3 },
    });
    const run = BoundedRoot.handle(() => undefined, {
      input: () => ({
        emoji: "🙂🙂",
        object: { first: 1, second: 2, third: 3, fourth: 4 },
        nested: { level_one: { level_two: { omitted: true } } },
      }),
    });

    expect(() => run()).not.toThrow();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      emoji: "🙂",
      object: { first: 1, second: 2, third: 3 },
    });
    expect(records[0]).not.toHaveProperty("object.fourth");
    expect(records[0]).not.toHaveProperty("nested.level_one.level_two");
    expect(records[0]?.["@amplio"]).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "value_string_truncated" }),
        expect.objectContaining({ code: "value_keys_truncated" }),
        expect.objectContaining({ code: "value_depth_exceeded" }),
      ]),
    });
    expect(
      Buffer.byteLength(String(records[0]?.emoji), "utf8"),
    ).toBeLessThanOrEqual(5);
  });

  it("omits a nested occurrence that exceeds its semantic byte budget", () => {
    const Call = event({
      id: "delivery.occurrence_bound",
      version: 1,
      schema: z.object({ value: z.string() }),
      timing: "instant",
      cardinality: { many: { max: 4 } },
    });
    const Provider = plugin({
      id: "delivery-occurrence-bound",
      events: { calls: Call },
      instrument({ events, record }) {
        return (value: string): void => record(events.calls, { value });
      },
    });
    const Root = event({
      id: "delivery.occurrence_bound_root",
      version: 1,
      schema: z.object({}),
      tree: { provider: Provider.events },
    });
    const records = collect({ limits: { maxOccurrenceBytes: 128 } });

    Root.handle(() => {
      Provider("small");
      Provider("x".repeat(256));
    })();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: { calls: [{ value: "small" }] },
      "@amplio": {
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: "occurrence_oversize",
            path: ["provider", "calls", 1],
          }),
        ]),
      },
    });
    expect(JSON.stringify(records[0])).not.toContain("x".repeat(64));
  });

  it("reduces an oversized root by dropping newest repeated occurrences", () => {
    const Entry = event({
      id: "delivery.root_reduction_entry",
      version: 1,
      schema: z.object({ value: z.string() }),
      timing: "instant",
      cardinality: { many: { max: 8 } },
    });
    const Provider = plugin({
      id: "delivery-root-reduction",
      events: { entries: Entry },
      instrument({ events, record }) {
        return (value: string): void => record(events.entries, { value });
      },
    });
    const Root = event({
      id: "delivery.root_reduction",
      version: 1,
      schema: z.object({ label: z.string() }),
      tree: { provider: Provider.events },
    });
    const records = collect({ limits: { maxRecordBytes: 560 } });
    const values = ["first", "second", "third"].map(
      (label) => `${label}:${label.repeat(36)}`,
    );

    Root.handle(
      () => {
        for (const value of values) Provider(value);
      },
      { input: () => ({ label: "bounded" }) },
    )();

    expect(records).toHaveLength(1);
    const entries = (
      (records[0]?.provider as { entries?: Array<{ value: string }> })
        ?.entries ?? []
    ).map(({ value }) => value);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(values.length);
    expect(entries).toEqual(values.slice(0, entries.length));
    expect(records[0]?.["@amplio"]).toMatchObject({
      truncated: expect.arrayContaining([
        expect.objectContaining({
          path: ["provider", "entries"],
          max: 8,
          dropped: values.length - entries.length,
        }),
      ]),
    });
    expect(
      Buffer.byteLength(JSON.stringify(records[0]), "utf8"),
    ).toBeLessThanOrEqual(560);
  });
});

describe("Event privacy and sampling pipeline", () => {
  it("captures default redaction independently from legacy configuration generations", async () => {
    initLegacy({
      service: "legacy-before",
      env: "test",
      redact: false,
      sinks: [() => undefined],
    });
    const PrivateRoot = event({
      id: "privacy.generation_default",
      version: 1,
      schema: z.object({ email: z.string() }),
    });
    const records = collect();
    const work = deferred<void>();
    const run = PrivateRoot.handle(
      async () => {
        await work.promise;
      },
      {
        input: () => ({ email: "private@example.com" }),
      },
    );

    const result = run();
    initLegacy({
      service: "legacy-after",
      env: "test",
      redact: false,
      sinks: [() => undefined],
    });
    work.resolve();
    await result;

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ email: "[REDACTED]" });
    expect(JSON.stringify(records)).not.toContain("private@example.com");
  });

  it("snapshots mutable redaction and sampling rules for each configuration generation", async () => {
    const ConfigRoot = event({
      id: "privacy.immutable_config",
      version: 1,
      schema: z.object({ custom_secret: z.string(), decision: z.string() }),
    });
    const records: SinkRecord[] = [];
    const redact = { fields: ["custom_secret"] };
    const sampling = {
      rate: 0,
      keep: [{ field: "decision", equals: "keep" }],
    };
    init({
      service: "event-delivery-contract",
      env: "test",
      redact,
      sampling,
      sinks: [(record) => records.push(record)],
    });
    const work = deferred<void>();
    const run = ConfigRoot.handle(
      async () => {
        await work.promise;
      },
      {
        input: () => ({ custom_secret: "private-value", decision: "keep" }),
      },
    );

    const result = run();
    redact.fields.length = 0;
    sampling.keep[0]!.equals = "drop";
    work.resolve();
    await result;

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      custom_secret: "[REDACTED]",
      decision: "keep",
    });
    expect(JSON.stringify(records)).not.toContain("private-value");
  });

  it("redacts before either the sampler or sinks can observe sensitive data", () => {
    const PrivateRoot = event({
      id: "privacy.pipeline_order",
      version: 1,
      schema: z.object({ private_value: z.string(), visible: z.string() }),
    });
    const stages: string[] = [];
    const samplerValues: unknown[] = [];
    const sinkValues: unknown[] = [];
    initTarget({
      service: "event-delivery-contract",
      env: "test",
      redactor(record) {
        stages.push("redactor");
        return { ...record, private_value: "[REDACTED]" };
      },
      sampler(record) {
        stages.push("sampler");
        samplerValues.push(record.private_value);
        return true;
      },
      sinks: [
        (record) => {
          stages.push("sink");
          sinkValues.push(record.private_value);
        },
      ],
    });
    const run = PrivateRoot.handle(() => undefined, {
      input: () => ({ private_value: "raw-secret", visible: "safe" }),
    });

    run();

    expect(stages).toEqual(["redactor", "sampler", "sink"]);
    expect(samplerValues).toEqual(["[REDACTED]"]);
    expect(sinkValues).toEqual(["[REDACTED]"]);
    expect(JSON.stringify([samplerValues, sinkValues])).not.toContain(
      "raw-secret",
    );
  });

  it.each([
    [
      "throws",
      (_record: SinkRecord): unknown => {
        throw new Error("redactor failed");
      },
    ],
    [
      "returns schema-invalid output",
      (record: SinkRecord): unknown => ({ ...record, secret: 42 }),
    ],
  ])("drops fail-closed when the redactor %s", (_scenario, redactor) => {
    const PrivateRoot = event({
      id: "privacy.fail_closed",
      version: 1,
      schema: z.object({ secret: z.string() }),
    });
    const records: SinkRecord[] = [];
    let samplerCalls = 0;
    initTarget({
      service: "event-delivery-contract",
      env: "test",
      redactor,
      sampler() {
        samplerCalls += 1;
        return true;
      },
      sinks: [(record) => records.push(record)],
    });
    const applicationResult = { ok: true };
    const run = PrivateRoot.handle(() => applicationResult, {
      input: () => ({ secret: "must-never-fall-back" }),
    });

    expect(run()).toBe(applicationResult);
    expect(samplerCalls).toBe(0);
    expect(records).toEqual([]);
  });

  it("revalidates schema values after redaction instead of checking shape only", () => {
    const LiteralRoot = event({
      id: "privacy.literal_contract",
      version: 1,
      schema: z.object({ provider: z.literal("safe") }),
    });
    const records: SinkRecord[] = [];
    const diagnostics: TargetDiagnostic[] = [];
    initTarget({
      service: "event-delivery-contract",
      env: "test",
      redactor(record) {
        return { ...record, provider: "attacker" };
      },
      onDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
      sinks: [(record) => records.push(record)],
    });
    const run = LiteralRoot.handle(() => "application-result", {
      input: () => ({ provider: "safe" }),
    });

    expect(run()).toBe("application-result");
    expect(records).toEqual([]);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "post_redaction_validation_failed",
          event: "privacy.literal_contract",
        }),
      ]),
    );
  });

  it("drops a redactor that corrupts or adds resource attributes", () => {
    const ResourceRoot = event({
      id: "privacy.resource_contract",
      version: 1,
      schema: z.object({}),
    });
    const records: SinkRecord[] = [];
    const diagnostics: TargetDiagnostic[] = [];
    initTarget({
      service: "event-delivery-contract",
      env: "test",
      enrichers: [() => ({ region: "safe" })],
      redactor(record) {
        return {
          ...record,
          resource: { region: { secret: "must-not-escape" } },
        };
      },
      onDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
      sinks: [(record) => records.push(record)],
    });

    expect(ResourceRoot.handle(() => "application-result")()).toBe(
      "application-result",
    );
    expect(records).toEqual([]);
    expect(JSON.stringify(records)).not.toContain("must-not-escape");
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "post_redaction_validation_failed",
          event: "privacy.resource_contract",
        }),
      ]),
    );
  });

  it("drops undeclared fields injected into a mounted Event tree group", () => {
    const AuthEntry = event({
      id: "privacy.auth_entry",
      version: 1,
      schema: z.object({ method: z.string() }),
      timing: "instant",
    });
    const AuthPlugin = plugin({
      id: "privacy-auth",
      events: { entries: AuthEntry },
      instrument({ events, record }) {
        return (): void => record(events.entries, { method: "password" });
      },
    });
    const Root = event({
      id: "privacy.group_contract",
      version: 1,
      schema: z.object({}),
      tree: { auth: AuthPlugin.events },
    });
    const records: SinkRecord[] = [];
    const diagnostics: TargetDiagnostic[] = [];
    initTarget({
      service: "event-delivery-contract",
      env: "test",
      redactor(record) {
        return {
          ...record,
          auth: {
            ...(record.auth as Record<string, unknown>),
            token: "must-not-escape",
          },
        };
      },
      onDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
      sinks: [(record) => records.push(record)],
    });

    expect(Root.handle(() => AuthPlugin())()).toBeUndefined();
    expect(records).toEqual([]);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "post_redaction_validation_failed",
          event: "privacy.group_contract",
        }),
      ]),
    );
  });

  it("keeps by canonical @event and semantic paths, with deterministic global-regex decisions", () => {
    const CanonicalKeep = event({
      id: "sampling.canonical_keep",
      version: 1,
      schema: z.object({}),
    });
    const CanonicalDrop = event({
      id: "sampling.canonical_drop",
      version: 1,
      schema: z.object({}),
    });
    const PathRoot = event({
      id: "sampling.path_keep",
      version: 1,
      schema: z.object({ http: z.object({ status: z.number().int() }) }),
    });
    const RegexRoot = event({
      id: "sampling.regex_keep",
      version: 1,
      schema: z.object({ request_id: z.string() }),
    });
    const records: SinkRecord[] = [];
    const deterministicPattern = /^keep_/g;
    initTarget({
      service: "event-delivery-contract",
      env: "test",
      sampling: {
        rate: 0,
        keep: [
          { field: "@event", equals: "sampling.canonical_keep" },
          { field: "http.status", gte: 500 },
          { field: "request_id", matches: deterministicPattern },
        ],
      },
      sinks: [(record) => records.push(record)],
    });

    CanonicalKeep.handle(() => undefined)();
    CanonicalDrop.handle(() => undefined)();
    const path = PathRoot.handle((status: number) => status, {
      input: ({ args: [status] }) => ({ http: { status } }),
    });
    path(200);
    path(503);
    const regex = RegexRoot.handle((requestId: string) => requestId, {
      input: ({ args: [requestId] }) => ({ request_id: requestId }),
    });
    regex("keep_same");
    regex("keep_same");
    regex("drop_me");

    expect(records).toHaveLength(4);
    expect(records.map((record) => record["@event"])).toEqual([
      "sampling.canonical_keep",
      "sampling.path_keep",
      "sampling.regex_keep",
      "sampling.regex_keep",
    ]);
    expect(records[1]).toMatchObject({ http: { status: 503 } });
    expect(records[2]).toMatchObject({ request_id: "keep_same" });
    expect(records[3]).toMatchObject({ request_id: "keep_same" });
    expect(deterministicPattern.lastIndex).toBe(0);
  });

  it("gives a custom sampler an isolated immutable record", () => {
    const Root = event({
      id: "sampling.immutable_input",
      version: 1,
      schema: z.object({ visible: z.string() }),
    });
    const records: SinkRecord[] = [];
    let samplerRecordWasFrozen = false;
    initTarget({
      service: "event-delivery-contract",
      env: "test",
      sampler(record) {
        samplerRecordWasFrozen = Object.isFrozen(record);
        Reflect.set(record, "success", "corrupted");
        Reflect.set(record, "injected_secret", "TOP_SECRET_AFTER_VALIDATION");
        return true;
      },
      sinks: [(record) => records.push(record)],
    });

    Root.handle(() => undefined, {
      input: () => ({ visible: "safe" }),
    })();

    expect(samplerRecordWasFrozen).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ visible: "safe", success: true });
    expect(records[0]).not.toHaveProperty("injected_secret");
    expect(JSON.stringify(records)).not.toContain("TOP_SECRET_AFTER_VALIDATION");
  });

  it("passes only resource attributes to enrichers and cannot mutate semantic data", () => {
    const ResourceRoot = event({
      id: "delivery.resource_enrichment",
      version: 1,
      schema: z.object({ semantic: z.string() }),
    });
    const records: SinkRecord[] = [];
    let enricherInput: ResourceAttributes | undefined;
    initTarget({
      service: "event-delivery-contract",
      env: "test",
      enrichers: [
        (current) => {
          enricherInput = current;
          return {
            ...current,
            region: "us-west-2",
            semantic: "resource-only-attempt",
          };
        },
      ],
      sinks: [(record) => records.push(record)],
    });
    const run = ResourceRoot.handle(() => undefined, {
      input: () => ({ semantic: "business-value" }),
    });

    run();

    expect(enricherInput).toEqual({});
    expect(enricherInput).not.toHaveProperty("semantic");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      semantic: "business-value",
      resource: {
        region: "us-west-2",
        semantic: "resource-only-attempt",
      },
    });
  });
});

describe("Event sinks, flush, and runtime generations", () => {
  it("applies pending-delivery backpressure per sink and continues healthy sinks", async () => {
    const Root = event({
      id: "delivery.sink_backpressure",
      version: 1,
      schema: z.object({ label: z.string() }),
    });
    const blocked = deferred();
    const overloadedLabels: string[] = [];
    const healthyLabels: string[] = [];
    const diagnostics: TargetDiagnostic[] = [];
    const overloaded: TargetSink = (record) => {
      overloadedLabels.push(record.label as string);
      return blocked.promise;
    };
    const healthy: TargetSink = (record) => {
      healthyLabels.push(record.label as string);
    };
    initTarget({
      service: "event-delivery-contract",
      env: "test",
      sinks: [overloaded, healthy],
      delivery: { maxPendingPerSink: 1 },
      onDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
    });
    const emit = Root.handle((label: string) => label, {
      input: ({ args: [label] }) => ({ label }),
    });

    expect(emit("first")).toBe("first");
    expect(emit("second")).toBe("second");
    await Promise.resolve();

    const observedOverloadedLabels = [...overloadedLabels];
    const observedHealthyLabels = [...healthyLabels];
    const observedDiagnostics = [...diagnostics];
    blocked.resolve();
    await flushTarget();

    expect({
      overloadedLabels: observedOverloadedLabels,
      healthyLabels: observedHealthyLabels,
      diagnostics: observedDiagnostics,
    }).toEqual({
      overloadedLabels: ["first"],
      healthyLabels: ["first", "second"],
      diagnostics: [
        expect.objectContaining({
          code: "sink_backpressure_drop",
          event: "delivery.sink_backpressure",
        }),
      ],
    });
  });

  it("deduplicates repeated sink identities for delivery and flushing", async () => {
    const Root = event({
      id: "delivery.duplicate_sink_identity",
      version: 1,
      schema: z.object({}),
    });
    let deliveryCalls = 0;
    let flushCalls = 0;
    const sink = (() => {
      deliveryCalls += 1;
    }) as TargetSink;
    sink.flush = () => {
      flushCalls += 1;
    };
    initTarget({
      service: "event-delivery-contract",
      env: "test",
      sinks: [sink, sink, sink],
    });

    Root.handle(() => undefined)();
    await flushTarget();

    expect(deliveryCalls).toBe(1);
    expect(flushCalls).toBe(1);
  });

  it("flushes hooks and pending deliveries retained by a replaced configuration generation", async () => {
    const Root = event({
      id: "delivery.retired_generation_flush",
      version: 1,
      schema: z.object({}),
    });
    const retiredDelivery = deferred();
    let retiredHookCalls = 0;
    let activeHookCalls = 0;
    const retiredSink = (() => retiredDelivery.promise) as TargetSink;
    retiredSink.flush = () => {
      retiredHookCalls += 1;
    };
    const activeSink = (() => undefined) as TargetSink;
    activeSink.flush = () => {
      activeHookCalls += 1;
    };
    initTarget({
      service: "generation-a",
      env: "test",
      sinks: [retiredSink],
    });
    Root.handle(() => undefined)();
    initTarget({
      service: "generation-b",
      env: "test",
      sinks: [activeSink],
    });

    const flushing = flushTarget({ timeoutMs: 1_000 });
    const immediateRetiredHookCalls = retiredHookCalls;
    const immediateActiveHookCalls = activeHookCalls;

    retiredDelivery.resolve();
    await expect(flushing).resolves.toEqual({
      completed: expect.any(Number),
      pending: 0,
      failures: 0,
    });
    expect({ immediateRetiredHookCalls, immediateActiveHookCalls }).toEqual({
      immediateRetiredHookCalls: 1,
      immediateActiveHookCalls: 1,
    });
  });

  it("refuses replacement atomically when open roots exhaust the retired-generation bound", async () => {
    const Root = event({
      id: "delivery.config_generation_limit",
      version: 1,
      schema: z.object({ marker: z.string() }),
    });
    const firstGate = deferred();
    const secondGate = deferred();
    const generationA: string[] = [];
    const generationB: string[] = [];
    const generationC: string[] = [];
    const diagnostics: TargetDiagnostic[] = [];
    const delivery = {
      maxRetiredGenerations: 1,
      retiredGenerationTtlMs: 1_000,
    };
    const diagnostic = (value: TargetDiagnostic): void => {
      diagnostics.push(value);
    };
    initTarget({
      service: "generation-a",
      env: "test",
      sinks: [(record) => generationA.push(record.marker as string)],
      delivery,
      onDiagnostic: diagnostic,
    });
    const holdOpen = Root.handle(
      async (marker: string, gate: Promise<void>) => {
        await gate;
        return marker;
      },
      { input: ({ args: [marker] }) => ({ marker }) },
    );
    const openedUnderA = holdOpen("a", firstGate.promise);

    initTarget({
      service: "generation-b",
      env: "test",
      sinks: [(record) => generationB.push(record.marker as string)],
      delivery,
      onDiagnostic: diagnostic,
    });
    const openedUnderB = holdOpen("b", secondGate.promise);

    initTarget({
      service: "generation-c",
      env: "test",
      sinks: [(record) => generationC.push(record.marker as string)],
      delivery,
      onDiagnostic: diagnostic,
    });
    Root.handle((marker: string) => marker, {
      input: ({ args: [marker] }) => ({ marker }),
    })("probe");

    firstGate.resolve();
    secondGate.resolve();
    await Promise.all([openedUnderA, openedUnderB]);

    expect({
      generationA,
      generationB,
      generationC,
      diagnosticCodes: diagnostics.map(({ code }) => code),
    }).toEqual({
      generationA: ["a"],
      generationB: ["probe", "b"],
      generationC: [],
      diagnosticCodes: expect.arrayContaining(["config_generation_limit"]),
    });
  });

  it("abandons a retired generation's hung deliveries after its finite TTL", async () => {
    const Root = event({
      id: "delivery.retired_generation_ttl",
      version: 1,
      schema: z.object({}),
    });
    const hung = deferred();
    const diagnostics: TargetDiagnostic[] = [];
    const delivery = {
      flushTimeoutMs: 50,
      maxRetiredGenerations: 2,
      retiredGenerationTtlMs: 10,
    };
    const diagnostic = (value: TargetDiagnostic): void => {
      diagnostics.push(value);
    };
    initTarget({
      service: "generation-a",
      env: "test",
      sinks: [() => hung.promise],
      delivery,
      onDiagnostic: diagnostic,
    });
    Root.handle(() => undefined)();
    initTarget({
      service: "generation-b",
      env: "test",
      sinks: [() => undefined],
      delivery,
      onDiagnostic: diagnostic,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    const flushing = flushTarget({ timeoutMs: 50 });
    const outcome = await raceWithDeadline(flushing, 200);
    hung.resolve();
    await flushing;

    expect(outcome).not.toBe(TIMED_OUT);
    if (outcome === TIMED_OUT) return;
    expect({
      pending: outcome.pending,
      failures: outcome.failures,
      diagnosticCodes: diagnostics.map(({ code }) => code),
    }).toEqual({
      pending: 0,
      failures: 0,
      diagnosticCodes: expect.arrayContaining(["sink_generation_abandoned"]),
    });
  });

  it("isolates synchronous, asynchronous, and thenable sink failures and continues later sinks", async () => {
    const Root = event({
      id: "delivery.sink_isolation",
      version: 1,
      schema: z.object({ value: z.string() }),
    });
    const calls: string[] = [];
    const syncFailure: TargetSink = () => {
      calls.push("sync-failure");
      throw new Error("sync sink failed");
    };
    const asyncFailure: TargetSink = () => {
      calls.push("async-failure");
      return Promise.reject(new Error("async sink failed"));
    };
    const thenableFailure: TargetSink = () => {
      calls.push("thenable-failure");
      return {
        then(_resolve, reject) {
          calls.push("thenable-settled");
          reject?.(new Error("thenable sink failed"));
        },
      } as unknown as PromiseLike<void>;
    };
    const healthy: TargetSink = () => {
      calls.push("healthy");
    };
    initTarget({
      service: "event-delivery-contract",
      env: "test",
      sinks: [syncFailure, asyncFailure, thenableFailure, healthy],
    });
    const run = Root.handle(() => "application-result", {
      input: () => ({ value: "safe" }),
    });

    expect(run()).toBe("application-result");
    await flushTarget();

    expect(calls).toEqual([
      "sync-failure",
      "async-failure",
      "thenable-failure",
      "healthy",
      "thenable-settled",
    ]);
  });

  it("invokes flush hooks synchronously and drains only the start-time delivery watermark", async () => {
    const Root = event({
      id: "delivery.flush_watermark",
      version: 1,
      schema: z.object({ sequence: z.number().int() }),
    });
    const firstDelivery = deferred();
    const secondDelivery = deferred();
    const firstHook = deferred();
    const order: string[] = [];
    let hookCalls = 0;
    const sink = ((record: SinkRecord) => {
      const sequence = record.sequence as number;
      order.push(`sink:${sequence}`);
      return sequence === 1 ? firstDelivery.promise : secondDelivery.promise;
    }) as TargetSink;
    sink.flush = () => {
      hookCalls += 1;
      order.push(`flush:${hookCalls}`);
      return hookCalls === 1 ? firstHook.promise : undefined;
    };
    initTarget({
      service: "event-delivery-contract",
      env: "test",
      sinks: [sink],
      delivery: { flushTimeoutMs: 1_000 },
    });
    const emit = Root.handle((sequence: number) => sequence, {
      input: ({ args: [sequence] }) => ({ sequence }),
    });

    emit(1);
    const firstFlush = flushTarget({ timeoutMs: 1_000 });
    const orderImmediatelyAfterFlush = [...order];
    emit(2);
    firstDelivery.resolve();
    firstHook.resolve();

    const firstOutcome = await raceWithDeadline(firstFlush);
    secondDelivery.resolve();
    await firstFlush;

    expect(orderImmediatelyAfterFlush).toEqual(["sink:1", "flush:1"]);
    expect(firstOutcome).not.toBe(TIMED_OUT);
    if (firstOutcome === TIMED_OUT) return;
    expect(firstOutcome).toEqual({
      completed: expect.any(Number),
      pending: 0,
      failures: 0,
    });

    const secondOutcome = await flushTarget({ timeoutMs: 1_000 });
    expect(secondOutcome).toEqual({
      completed: expect.any(Number),
      pending: 0,
      failures: 0,
    });
  });

  it("resolves a finite timeout result instead of waiting forever or rejecting", async () => {
    const Root = event({
      id: "delivery.flush_timeout",
      version: 1,
      schema: z.object({}),
    });
    const hung = deferred();
    initTarget({
      service: "event-delivery-contract",
      env: "test",
      sinks: [() => hung.promise],
      delivery: { flushTimeoutMs: 10 },
    });
    Root.handle(() => undefined)();

    const flushing = flushTarget({ timeoutMs: 10 });
    const outcome = await raceWithDeadline(flushing);
    hung.resolve();
    await flushing;

    expect(outcome).not.toBe(TIMED_OUT);
    if (outcome === TIMED_OUT) return;
    expect(outcome).toEqual({
      completed: 0,
      pending: 1,
      failures: 0,
    });
  });

  it("keeps the configuration generation captured when a root opened across init replacement", async () => {
    const Root = event({
      id: "delivery.config_generation",
      version: 1,
      schema: z.object({ marker: z.string() }),
    });
    const gate = deferred();
    const generationA: SinkRecord[] = [];
    const generationB: SinkRecord[] = [];
    initTarget({
      service: "generation-a",
      env: "test-a",
      sinks: [(record) => generationA.push(record)],
    });
    const run = Root.handle(async () => gate.promise, {
      input: () => ({ marker: "captured" }),
    });

    const openedUnderA = run();
    initTarget({
      service: "generation-b",
      env: "test-b",
      sinks: [(record) => generationB.push(record)],
    });
    gate.resolve();
    await openedUnderA;

    expect(generationA).toHaveLength(1);
    expect(generationA[0]).toMatchObject({
      service: "generation-a",
      env: "test-a",
      marker: "captured",
    });
    expect(generationB).toEqual([]);

    await run();
    expect(generationB).toHaveLength(1);
    expect(generationB[0]).toMatchObject({
      service: "generation-b",
      env: "test-b",
      marker: "captured",
    });
  });

  it("retains an expired generation while one of its root Events is still open", async () => {
    const Root = event({
      id: "delivery.open_retired_generation",
      version: 1,
      schema: z.object({ marker: z.string() }),
    });
    const gate = deferred<void>();
    const generationA: SinkRecord[] = [];
    let generationAFlushes = 0;
    const sinkA = ((record: SinkRecord) =>
      generationA.push(record)) as TargetSink;
    sinkA.flush = () => {
      generationAFlushes += 1;
    };
    initTarget({
      service: "generation-a",
      env: "test",
      sinks: [sinkA],
      delivery: { retiredGenerationTtlMs: 1 },
    });
    const run = Root.handle(async () => gate.promise, {
      input: () => ({ marker: "still-open" }),
    });
    const open = run();

    initTarget({
      service: "generation-b",
      env: "test",
      sinks: [() => undefined],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await flushTarget({ timeoutMs: 50 });

    expect(generationAFlushes).toBe(1);
    gate.resolve();
    await open;
    expect(generationA).toHaveLength(1);
    expect(generationA[0]).toMatchObject({ marker: "still-open" });
  });
});

describe("Out-of-band diagnostics", () => {
  it("rate-limits safe development diagnostics when no callback is configured", () => {
    const Root = event({
      id: "delivery.default_diagnostic_channel",
      version: 1,
      schema: z.object({ secret: z.string() }),
    });
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      initTarget({
        service: "event-delivery-contract",
        env: "test",
        redactor() {
          throw new Error("private diagnostic detail");
        },
        sinks: [() => undefined],
      });
      const run = Root.handle(() => undefined, {
        input: () => ({ secret: "must-not-escape" }),
      });

      run();
      run();
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[0])).toContain("redactor_failed");
    expect(String(warnings[0]?.[0])).toContain(
      "delivery.default_diagnostic_channel",
    );
    expect(JSON.stringify(warnings)).not.toContain("must-not-escape");
    expect(JSON.stringify(warnings)).not.toContain("private diagnostic detail");
  });

  it("allows only one asynchronous diagnostic callback to remain active", async () => {
    const Root = event({
      id: "delivery.diagnostic_concurrency",
      version: 1,
      schema: z.object({}),
    });
    const callback = deferred<void>();
    let callbackCalls = 0;
    initTarget({
      service: "event-delivery-contract",
      env: "test",
      redactor() {
        throw new Error("force an out-of-band diagnostic");
      },
      onDiagnostic() {
        callbackCalls += 1;
        return callback.promise;
      },
      sinks: [() => undefined],
    });
    const run = Root.handle(() => undefined);

    run();
    run();
    expect(callbackCalls).toBe(1);

    callback.resolve();
    await callback.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    run();
    expect(callbackCalls).toBe(2);
  });

  it("isolates diagnostic concurrency guards between runtime generations", () => {
    const Root = event({
      id: "delivery.diagnostic_generation",
      version: 1,
      schema: z.object({}),
    });
    const pending = deferred<void>();
    const seen: string[] = [];
    initTarget({
      service: "generation-a",
      env: "test",
      redactor() {
        throw new Error("generation a diagnostic");
      },
      onDiagnostic(diagnostic) {
        seen.push(`a:${diagnostic.code}`);
        return pending.promise;
      },
      sinks: [() => undefined],
    });
    Root.handle(() => undefined)();

    initTarget({
      service: "generation-b",
      env: "test",
      redactor() {
        throw new Error("generation b diagnostic");
      },
      onDiagnostic(diagnostic) {
        seen.push(`b:${diagnostic.code}`);
      },
      sinks: [() => undefined],
    });
    Root.handle(() => undefined)();

    expect(seen).toEqual(["a:redactor_failed", "b:redactor_failed"]);
    pending.resolve();
  });

  it("consumes a rejecting thenable returned by onDiagnostic", async () => {
    const Root = event({
      id: "delivery.diagnostic_rejecting_thenable",
      version: 1,
      schema: z.object({ private_value: z.string() }),
    });
    const records: SinkRecord[] = [];
    let callbackCalls = 0;
    let thenCalls = 0;
    initTarget({
      service: "event-delivery-contract",
      env: "test",
      redactor() {
        throw new Error("force an out-of-band diagnostic");
      },
      onDiagnostic() {
        callbackCalls += 1;
        const rejection = Promise.reject<void>(
          new Error("diagnostic thenable rejected"),
        );
        return {
          then(resolve, reject) {
            thenCalls += 1;
            return rejection.then(resolve, reject);
          },
        } as PromiseLike<void>;
      },
      sinks: [(record) => records.push(record)],
    });
    const run = Root.handle((value: string) => value, {
      input: ({ args: [value] }) => ({ private_value: value }),
    });

    expect(run("application-result")).toBe("application-result");
    await Promise.resolve();
    await Promise.resolve();

    expect(callbackCalls).toBe(1);
    expect(thenCalls).toBe(1);
    expect(records).toEqual([]);
  });

  it("isolates callback failures and prevents diagnostic-triggered Event reentrancy", async () => {
    const Root = event({
      id: "delivery.diagnostic_reentrancy",
      version: 1,
      schema: z.object({ private_value: z.string() }),
    });
    const records: SinkRecord[] = [];
    const diagnostics: TargetDiagnostic[] = [];
    let recursiveApplicationCalls = 0;
    const run = Root.handle(
      (secret: string) => {
        if (secret === "recursive") recursiveApplicationCalls += 1;
        return secret;
      },
      {
        input: ({ args: [secret] }) => ({ private_value: secret }),
      },
    );
    initTarget({
      service: "event-delivery-contract",
      env: "test",
      redactor(record) {
        if (record.private_value === "trigger") {
          throw new Error("force an out-of-band diagnostic");
        }
        return record;
      },
      onDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
        run("recursive");
        throw new Error("diagnostic callback failed");
      },
      sinks: [(record) => records.push(record)],
    });

    expect(run("trigger")).toBe("trigger");
    await Promise.resolve();

    expect(recursiveApplicationCalls).toBe(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ code: expect.any(String) });
    expect(JSON.stringify(diagnostics[0])).not.toContain("trigger");
    expect(records).toEqual([]);
  });
});
