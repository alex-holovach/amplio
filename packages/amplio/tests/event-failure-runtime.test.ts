import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { event, init, type Schema, type SinkRecord } from "../src/index.js";
import { openEvent, plugin } from "../src/plugin.js";

type RuntimeDiagnostic = {
  readonly code: string;
  readonly event?: string;
  readonly path?: readonly (string | number)[];
  readonly [key: string]: unknown;
};

type FailureRuntimeConfig = Parameters<typeof init>[0] & {
  readonly limits?: { readonly maxEventDurationMs?: number };
  readonly onDiagnostic?: (diagnostic: RuntimeDiagnostic) => unknown;
};

const configure = (limits?: FailureRuntimeConfig["limits"]) => {
  const records: SinkRecord[] = [];
  const diagnostics: RuntimeDiagnostic[] = [];
  const config: FailureRuntimeConfig = {
    service: "failure-contract",
    env: "test",
    sinks: [(record) => records.push(record)],
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    ...(limits ? { limits } : {}),
  };
  init(config);
  return { diagnostics, records };
};

const diagnosticCodes = (record: SinkRecord): string[] => {
  const metadata = record["@amplio"];
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    return [];
  }
  const diagnostics = (metadata as Record<string, unknown>).diagnostics;
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics.flatMap((diagnostic) => {
    if (diagnostic === null || typeof diagnostic !== "object") return [];
    const code = (diagnostic as { readonly code?: unknown }).code;
    return typeof code === "string" ? [code] : [];
  });
};

const diagnosticsFor = (record: SinkRecord): RuntimeDiagnostic[] => {
  const metadata = record["@amplio"];
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    return [];
  }
  const diagnostics = (metadata as Record<string, unknown>).diagnostics;
  return Array.isArray(diagnostics)
    ? diagnostics.filter(
        (diagnostic): diagnostic is RuntimeDiagnostic =>
          diagnostic !== null &&
          typeof diagnostic === "object" &&
          typeof (diagnostic as { readonly code?: unknown }).code === "string",
      )
    : [];
};

const throwingSchema = <Value extends Record<string, unknown>>(): Schema<
  Value,
  Value
> => ({
  "~standard": {
    version: 1,
    vendor: "failure-contract",
    validate(): never {
      throw new Error("schema implementation failed");
    },
  },
});

const SafeRoot = event({
  id: "contract.safe_root",
  version: 1,
  schema: z.object({
    request_id: z.string().optional(),
    marker: z.string().optional(),
    payload: z.unknown().optional(),
  }),
});

const PromiseRoot = event({
  id: "contract.promise_root",
  version: 1,
  schema: z.object({ request_id: z.string() }),
});

const InvalidNested = event({
  id: "contract.invalid_nested",
  version: 1,
  schema: throwingSchema<{ label: string }>(),
  timing: "duration",
  cardinality: { many: { max: 4 } },
});

const InvalidNestedPlugin = plugin({
  id: "invalid-nested",
  events: { calls: InvalidNested },
  instrument({ events, observe }) {
    return <F extends (label: string) => unknown>(fn: F): F =>
      observe(events.calls, fn, {
        input: ({ args: [label] }) => ({ label }),
      });
  },
});

const RootWithInvalidNested = event({
  id: "contract.root_with_invalid_nested",
  version: 1,
  schema: z.object({ request_id: z.string() }),
  tree: { invalid: InvalidNestedPlugin.events },
});

const InvalidRoot = event({
  id: "contract.invalid_root",
  version: 1,
  schema: throwingSchema<{ request_id: string }>(),
});

const TimedRoot = event({
  id: "contract.timed_root",
  version: 1,
  schema: z.object({ request_id: z.string() }),
  maxDurationMs: 25,
});

const TimedNested = event({
  id: "contract.timed_nested",
  version: 1,
  schema: z.object({
    label: z.string(),
    phase: z.string().optional(),
  }),
  timing: "duration",
  cardinality: { many: { max: 4 } },
  maxDurationMs: 25,
});

const TimedNestedPlugin = plugin({
  id: "timed-nested",
  events: { calls: TimedNested },
  instrument({ events, begin }) {
    return (label: string) => begin(events.calls, { label });
  },
});

const RootWithTimedNested = event({
  id: "contract.root_with_timed_nested",
  version: 1,
  schema: z.object({ request_id: z.string() }),
  tree: { provider: TimedNestedPlugin.events },
  maxDurationMs: 1_000,
});

const OversizedRoot = event({
  id: "contract.oversized_root",
  version: 1,
  schema: z.object({
    request_id: z.string(),
    payload: z.record(z.string()),
  }),
});

const PrototypeRoot = event({
  id: "contract.prototype_root",
  version: 1,
  schema: z.object({
    request_id: z.string(),
    payload: z.unknown(),
  }),
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Event failure and finalization contract", () => {
  it("is behaviorally safe when init() has not run", () => {
    const result = { status: "ok" };
    const successful = SafeRoot.handle(() => result, {
      input: () => ({ request_id: "before_init" }),
    });
    expect(successful()).toBe(result);

    const thrown = Object.freeze({ code: "before_init_failure" });
    const failing = SafeRoot.handle(
      () => {
        throw thrown;
      },
      { input: () => ({ request_id: "before_init_failure" }) },
    );
    let caught: unknown;
    try {
      failing();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(thrown);
  });

  it("isolates throwing, thenable, and hostile projector output", async () => {
    const { records } = configure();
    let projectorThenCalls = 0;
    const projectorFailure = new Error("projector rejected");
    const projectorThenable = {
      then(
        _resolve: (value: unknown) => unknown,
        reject: (reason: unknown) => unknown,
      ): void {
        projectorThenCalls += 1;
        reject(projectorFailure);
      },
    };
    const hostilePayload = new Proxy(Object.create(null) as object, {
      getPrototypeOf() {
        throw new Error("hostile projector prototype");
      },
      ownKeys() {
        throw new Error("hostile projector keys");
      },
    });
    const result = { status: "exact" };
    const hostileProjection = SafeRoot.handle(() => result, {
      input: () => ({
        request_id: "hostile_projection",
        marker: "safe_sibling",
        payload: hostilePayload,
      }),
      result: () => projectorThenable as never,
      success: () => {
        throw new Error("classifier failed");
      },
    });

    expect(hostileProjection()).toBe(result);

    const thrownProjectorResult = { status: "throwing_projector" };
    const throwingProjection = SafeRoot.handle(() => thrownProjectorResult, {
      input: () => {
        throw new Error("input projector failed");
      },
    });
    expect(throwingProjection()).toBe(thrownProjectorResult);

    await Promise.resolve();
    await Promise.resolve();

    expect(projectorThenCalls).toBeGreaterThan(0);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      request_id: "hostile_projection",
      marker: "safe_sibling",
      success: true,
    });
    expect(records[0]).not.toHaveProperty("payload");
    expect(diagnosticCodes(records[0]!)).toEqual(
      expect.arrayContaining([
        "serialization_failed",
        "async_projection_unsupported",
        "success_projection_failed",
      ]),
    );
    expect(diagnosticCodes(records[1]!)).toContain("projection_failed");
  });

  it("always rethrows the original hostile application value by identity", () => {
    const { records } = configure();
    const hostileThrown = new Proxy(Object.create(null) as object, {
      get() {
        throw new Error("hostile thrown getter");
      },
      getPrototypeOf() {
        throw new Error("hostile thrown prototype");
      },
      ownKeys() {
        throw new Error("hostile thrown keys");
      },
    });
    const hostileErrorProjection = new Proxy(Object.create(null) as object, {
      getPrototypeOf() {
        throw new Error("hostile error projection prototype");
      },
      ownKeys() {
        throw new Error("hostile error projection keys");
      },
    });
    const failing = SafeRoot.handle(
      () => {
        throw hostileThrown;
      },
      {
        input: () => ({ request_id: "hostile_throw" }),
        error: () => hostileErrorProjection as never,
      },
    );

    let caught: unknown;
    try {
      failing();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(hostileThrown);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      request_id: "hostile_throw",
      success: false,
      error: { type: "NonError" },
    });
    expect(diagnosticCodes(records[0]!)).toContain("projection_failed");
  });

  it("never copies arbitrary Error name or code values into the Event", () => {
    const { records } = configure();
    const thrown = Object.assign(new Error("private provider message"), {
      name: "SkLivePrivateApiKey",
      code: "TOP_SECRET_API_KEY",
    });
    const failing = SafeRoot.handle(
      () => {
        throw thrown;
      },
      { input: () => ({ request_id: "safe_error_metadata" }) },
    );

    let caught: unknown;
    try {
      failing();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(thrown);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      request_id: "safe_error_metadata",
      success: false,
      error: { type: "Error" },
    });
    expect(records[0]?.error).not.toHaveProperty("code");
    expect(JSON.stringify(records[0])).not.toContain("SkLivePrivateApiKey");
    expect(JSON.stringify(records[0])).not.toContain("TOP_SECRET_API_KEY");
    expect(JSON.stringify(records[0])).not.toContain("provider message");
  });

  it("drops root schema failures without changing application behavior", () => {
    const { diagnostics, records } = configure();
    const result = { status: "root_result" };
    const handler = InvalidRoot.handle(() => result, {
      input: () => ({ request_id: "invalid_root" }),
    });

    expect(handler()).toBe(result);
    expect(records).toEqual([]);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "root_validation_failed" }),
      ]),
    );
  });

  it("omits nested schema failures while preserving the provider result", () => {
    const { records } = configure();
    const providerResult = { provider_id: "provider_1" };
    const callInvalidProvider = InvalidNestedPlugin(() => providerResult);
    const handler = RootWithInvalidNested.handle(
      () => callInvalidProvider("invalid"),
      { input: () => ({ request_id: "nested_invalid" }) },
    );

    expect(handler()).toBe(providerResult);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      request_id: "nested_invalid",
      success: true,
    });
    expect(records[0]).not.toHaveProperty("invalid");
    expect(
      diagnosticsFor(records[0]!).some(
        (diagnostic) => diagnostic.event === InvalidNested.id,
      ),
    ).toBe(true);
  });

  it("returns custom application thenables untouched without observing them", () => {
    const { records } = configure();
    let thenReads = 0;
    let thenCalls = 0;
    const customThenable = Object.defineProperty(
      { token: "custom_thenable" },
      "then",
      {
        enumerable: true,
        get() {
          thenReads += 1;
          return (): void => {
            thenCalls += 1;
          };
        },
      },
    );
    const handler = PromiseRoot.handle(() => customThenable, {
      input: () => ({ request_id: "custom_thenable" }),
    });

    const returned = handler();

    expect(returned).toBe(customThenable);
    expect(thenReads).toBe(0);
    expect(thenCalls).toBe(0);
    expect(records).toHaveLength(1);
  });

  it("preserves native and cross-realm Promise identity and settlement", async () => {
    const { records } = configure();

    const nativeValue = { source: "native_fulfilled" };
    const nativeFulfilled = Promise.resolve(nativeValue);
    const returnNativeFulfilled = PromiseRoot.handle(() => nativeFulfilled, {
      input: () => ({ request_id: "native_fulfilled" }),
    });
    const returnedNativeFulfilled = returnNativeFulfilled();
    expect(returnedNativeFulfilled).toBe(nativeFulfilled);
    await expect(returnedNativeFulfilled).resolves.toBe(nativeValue);

    const nativeReason = Object.freeze({ code: "native_rejected" });
    const nativeRejected = Promise.reject(nativeReason);
    const returnNativeRejected = PromiseRoot.handle(() => nativeRejected, {
      input: () => ({ request_id: "native_rejected" }),
    });
    const returnedNativeRejected = returnNativeRejected();
    expect(returnedNativeRejected).toBe(nativeRejected);
    await expect(returnedNativeRejected).rejects.toBe(nativeReason);

    const crossValue = { source: "cross_fulfilled" };
    const crossFulfilled = runInNewContext("Promise.resolve(value)", {
      value: crossValue,
    }) as Promise<typeof crossValue>;
    const returnCrossFulfilled = PromiseRoot.handle(() => crossFulfilled, {
      input: () => ({ request_id: "cross_fulfilled" }),
    });
    const returnedCrossFulfilled = returnCrossFulfilled();
    expect(returnedCrossFulfilled).toBe(crossFulfilled);
    await expect(returnedCrossFulfilled).resolves.toBe(crossValue);

    const crossReason = Object.freeze({ code: "cross_rejected" });
    const crossRejected = runInNewContext("Promise.reject(reason)", {
      reason: crossReason,
    }) as Promise<never>;
    const returnCrossRejected = PromiseRoot.handle(() => crossRejected, {
      input: () => ({ request_id: "cross_rejected" }),
    });
    const returnedCrossRejected = returnCrossRejected();
    expect(returnedCrossRejected).toBe(crossRejected);
    await expect(returnedCrossRejected).rejects.toBe(crossReason);

    expect(records).toHaveLength(4);
    expect(records.map((record) => record.request_id)).toEqual([
      "native_fulfilled",
      "native_rejected",
      "cross_fulfilled",
      "cross_rejected",
    ]);
  });

  it("never reads a native Promise's user-controlled own then property", async () => {
    const { records } = configure();
    const applicationValue = { source: "hostile_own_then" };
    const applicationPromise = Promise.resolve(applicationValue);
    let thenReads = 0;
    Object.defineProperty(applicationPromise, "then", {
      configurable: true,
      get() {
        thenReads += 1;
        throw new Error("application then getter must stay untouched");
      },
    });
    const handler = PromiseRoot.handle(() => applicationPromise, {
      input: () => ({ request_id: "hostile_own_then" }),
    });

    const returned = handler();

    expect(returned).toBe(applicationPromise);
    expect(thenReads).toBe(0);
    await new Promise<void>((resolve, reject) => {
      Promise.prototype.then.call(returned, () => resolve(), reject);
    });
    expect(thenReads).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      request_id: "hostile_own_then",
      success: true,
    });
  });

  it("returns a genuine Promise subclass when its species blocks telemetry observation", () => {
    const { diagnostics, records } = configure();
    const speciesFailure = Object.freeze({ source: "hostile_species" });
    class HostileSpeciesPromise<T> extends Promise<T> {
      static get [Symbol.species](): PromiseConstructor {
        throw speciesFailure;
      }
    }
    const applicationPromise = new HostileSpeciesPromise<{ ok: true }>(
      (resolve) => resolve({ ok: true }),
    );
    const handler = PromiseRoot.handle(() => applicationPromise, {
      input: () => ({ request_id: "hostile_species" }),
    });

    let returned: typeof applicationPromise | undefined;
    expect(() => {
      returned = handler();
    }).not.toThrow();
    expect(returned).toBe(applicationPromise);
    expect(records).toEqual([]);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "promise_observation_failed",
          event: "contract.promise_root",
        }),
      ]),
    );
  });

  it("drops a root at maxDurationMs without changing its late Promise", async () => {
    vi.useFakeTimers();
    const { diagnostics, records } = configure();
    const applicationResult = { status: "eventually_complete" };
    let resolveApplication!: (value: typeof applicationResult) => void;
    const applicationPromise = new Promise<typeof applicationResult>(
      (resolve) => {
        resolveApplication = resolve;
      },
    );
    const handler = TimedRoot.handle(() => applicationPromise, {
      input: () => ({ request_id: "timed_root" }),
    });

    const returned = handler();
    expect(returned).toBe(applicationPromise);

    await vi.advanceTimersByTimeAsync(26);
    expect(records).toEqual([]);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "event_timeout" }),
      ]),
    );

    resolveApplication(applicationResult);
    await expect(returned).resolves.toBe(applicationResult);
    await Promise.resolve();

    expect(records).toEqual([]);
  });

  it("omits timed-out nested work and makes late updates inert", async () => {
    vi.useFakeTimers();
    const { records } = configure();
    const scope = openEvent(RootWithTimedNested, {
      request_id: "timed_nested",
    });
    const nested = scope.run(() => TimedNestedPlugin("initial"));

    await vi.advanceTimersByTimeAsync(26);
    nested.update({ label: "late", phase: "late_update" });
    nested.end({ phase: "late_end" });
    scope.finish();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ request_id: "timed_nested" });
    expect(records[0]).not.toHaveProperty("provider");
    expect(diagnosticCodes(records[0]!)).toContain("event_timeout");
    const metadata = records[0]?.["@amplio"] as
      { readonly incomplete?: readonly unknown[] } | undefined;
    expect(metadata?.incomplete ?? []).toEqual([]);
  });

  it("drops an oversized root and reports only a safe diagnostic", async () => {
    const { diagnostics, records } = configure();
    const secret = "TOP_SECRET_SHOULD_NOT_REACH_DIAGNOSTICS";
    const payload = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [
        `field_${index}`,
        `${index === 0 ? secret : "value"}:${"x".repeat(4_096)}`,
      ]),
    );
    const applicationResult = { status: "oversized_but_successful" };
    const handler = OversizedRoot.handle(() => applicationResult, {
      input: () => ({ request_id: "oversized", payload }),
    });

    expect(handler()).toBe(applicationResult);
    await Promise.resolve();

    expect(records).toEqual([]);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "record_oversize" }),
      ]),
    );
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
  });

  it("omits prototype-pollution keys while preserving safe siblings", () => {
    const { records } = configure();
    const payload = Object.create(null) as Record<string, unknown>;
    payload.safe = { value: "kept" };
    Object.defineProperties(payload, {
      __proto__: {
        enumerable: true,
        value: { amplified_polluted: true },
      },
      constructor: {
        enumerable: true,
        value: { amplified_polluted: true },
      },
      prototype: {
        enumerable: true,
        value: { amplified_polluted: true },
      },
    });
    const handler = PrototypeRoot.handle(() => undefined, {
      input: () => ({ request_id: "prototype", payload }),
    });

    expect(() => handler()).not.toThrow();
    expect(records).toHaveLength(1);
    expect(records[0]?.payload).toEqual({ safe: { value: "kept" } });
    const encodedPayload = JSON.stringify(records[0]?.payload);
    expect(encodedPayload).not.toContain('"__proto__"');
    expect(encodedPayload).not.toContain('"constructor"');
    expect(encodedPayload).not.toContain('"prototype"');
    expect(
      ({} as { readonly amplified_polluted?: unknown }).amplified_polluted,
    ).toBeUndefined();
  });
});
