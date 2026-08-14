import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { event, init, type SinkRecord } from "../src/index.js";
import { plugin } from "../src/plugin.js";

const packageRoot = path.resolve(import.meta.dirname, "..");
const typeFixtureConfig = path.join(
  packageRoot,
  "tests/fixtures/plugin-tools-contract/tsconfig.json",
);

const SignedIn = event({
  id: "auth.signed_in",
  version: 1,
  schema: z.object({ method: z.string(), user_id: z.string() }),
  timing: "instant",
  cardinality: { many: { max: 4 } },
});

const AuthPlugin = plugin({
  id: "auth",
  events: { signed_in: SignedIn },
  instrument({ events, record }) {
    return (value: { method: string; user_id: string }): void => {
      record(events.signed_in, value);
    };
  },
});

const RequestWithAuth = event({
  id: "http.request_with_auth",
  version: 1,
  schema: z.object({ request_id: z.string() }),
  tree: { auth: AuthPlugin.events },
});

const ProviderCall = event({
  id: "provider.call",
  version: 1,
  schema: z.object({ operation: z.string() }),
  timing: "duration",
  cardinality: { many: { max: 8 } },
});

const ProviderPlugin = plugin({
  id: "provider",
  events: { calls: ProviderCall },
  instrument({ events, observe }) {
    return <F extends (input: { operation: string }) => unknown>(fn: F): F =>
      observe(events.calls, fn, {
        input: ({ args: [input] }) => ({ operation: input.operation }),
      });
  },
});

const RequestWithProvider = event({
  id: "http.request_with_provider",
  version: 1,
  schema: z.object({ request_id: z.string() }),
  tree: { provider: ProviderPlugin.events },
});

const AttemptStep = event({
  id: "payment.attempt_step",
  version: 1,
  schema: z.object({ label: z.string() }),
  timing: "instant",
  cardinality: { many: { max: 4 } },
});

const AttemptStepPlugin = plugin({
  id: "payment-attempt-step",
  events: { steps: AttemptStep },
  instrument({ events, record }) {
    return (label: string): void => {
      record(events.steps, { label });
    };
  },
});

const PaymentAttempt = event({
  id: "payment.attempt",
  version: 1,
  schema: z.object({
    attempt: z.number().int(),
    state: z.object({
      phase: z.string(),
      outcome: z.string().optional(),
    }),
  }),
  timing: "duration",
  cardinality: { many: { max: 4 } },
  tree: { work: AttemptStepPlugin.events },
});

const PaymentPlugin = plugin({
  id: "payment",
  events: { attempts: PaymentAttempt },
  instrument({ events, begin }) {
    return (input?: {
      attempt?: number;
      state?: { phase?: string; outcome?: string };
    }) => begin(events.attempts, input);
  },
});

const RequestWithPayment = event({
  id: "http.request_with_payment",
  version: 1,
  schema: z.object({ request_id: z.string() }),
  tree: { payment: PaymentPlugin.events },
});

const RetainedCall = event({
  id: "provider.retained_call",
  version: 1,
  schema: z.object({ operation: z.string() }),
  timing: "duration",
  cardinality: { many: { max: 4 } },
});

const RetainedPlugin = plugin({
  id: "retained",
  events: { calls: RetainedCall },
  instrument({ events, begin }) {
    return () =>
      (begin as unknown as (...args: unknown[]) => ReturnType<typeof begin>)(
        events.calls,
        { operation: "stream" },
        { retainParent: true },
      );
  },
});

const RequestWithRetainedCall = event({
  id: "http.request_with_retained_call",
  version: 1,
  schema: z.object({ request_id: z.string() }),
  tree: { provider: RetainedPlugin.events },
});

const PlainRequest = event({
  id: "http.plain_request",
  version: 1,
  schema: z.object({ request_id: z.string() }),
});

const HostileConsoleCall = event({
  id: "provider.hostile_console_call",
  version: 1,
  schema: z.object({ operation: z.string() }),
  timing: "duration",
});

const HostileConsolePlugin = plugin({
  id: "hostile-console",
  events: { call: HostileConsoleCall },
  instrument({ events, observe }) {
    return <F extends (operation: string) => unknown>(fn: F): F =>
      observe(events.call, fn, {
        input: ({ args: [operation] }) => ({ operation }),
      });
  },
});

const HostileClockCall = event({
  id: "provider.hostile_clock_call",
  version: 1,
  schema: z.object({ operation: z.string() }),
  timing: "duration",
});

const HostileClockPlugin = plugin({
  id: "hostile-clock",
  events: { call: HostileClockCall },
  instrument({ events, observe }) {
    return <F extends (operation: string) => unknown>(fn: F): F =>
      observe(events.call, fn, {
        input: ({ args: [operation] }) => ({ operation }),
      });
  },
});

describe("Plugin tools contract", () => {
  it("enforces plugin ownership and timing through the public declarations", () => {
    execFileSync("pnpm", ["exec", "tsc", "-p", typeFixtureConfig], {
      cwd: packageRoot,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: "pipe",
    });

    expect(true).toBe(true);
  });

  it("record() creates an occurrence of an exact mounted instant Event", () => {
    const delivered: SinkRecord[] = [];
    init({
      service: "orders-api",
      env: "test",
      sinks: [(record) => delivered.push(record)],
    });

    const applicationResult = { status: 204 };
    const handleRequest = RequestWithAuth.handle(
      () => {
        AuthPlugin({ method: "password", user_id: "user_1" });
        return applicationResult;
      },
      { input: () => ({ request_id: "req_1" }) },
    );

    expect(handleRequest()).toBe(applicationResult);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      "@event": "http.request_with_auth",
      request_id: "req_1",
      success: true,
      auth: {
        signed_in: [{ method: "password", user_id: "user_1" }],
      },
    });
    expect(delivered[0]?.auth).not.toMatchObject({
      signed_in: [
        {
          duration_ms: expect.any(Number),
          success: expect.any(Boolean),
        },
      ],
    });
  });

  it("observe() preserves exact synchronous results and thrown values", () => {
    const delivered: SinkRecord[] = [];
    init({
      service: "orders-api",
      env: "test",
      sinks: [(record) => delivered.push(record)],
    });

    const result = { provider_id: "provider_1" };
    const observedSuccess = ProviderPlugin(() => result);
    const successfulRequest = RequestWithProvider.handle(
      () => observedSuccess({ operation: "create" }),
      { input: () => ({ request_id: "req_success" }) },
    );

    expect(successfulRequest()).toBe(result);

    const thrown = Object.freeze({ code: "provider_failed" });
    const observedFailure = ProviderPlugin(() => {
      throw thrown;
    });
    const failingRequest = RequestWithProvider.handle(
      () => observedFailure({ operation: "delete" }),
      { input: () => ({ request_id: "req_failure" }) },
    );

    let caught: unknown;
    try {
      failingRequest();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(thrown);

    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toMatchObject({
      request_id: "req_success",
      provider: {
        calls: [{ operation: "create", success: true }],
      },
    });
    expect(delivered[1]).toMatchObject({
      request_id: "req_failure",
      success: false,
      provider: {
        calls: [{ operation: "delete", success: false }],
      },
    });
  });

  it("preserves overloaded calls, this, arguments, callbacks, and call count", () => {
    const OverloadedCall = event({
      id: "provider.overloaded_call",
      version: 1,
      schema: z.object({}),
      timing: "duration",
      cardinality: { many: { max: 4 } },
    });
    const owner = { prefix: "native" };
    type Owner = typeof owner;
    const calls: Array<{
      owner: Owner;
      input: string | number;
      callback: (value: string | number) => void;
    }> = [];
    function providerCall(
      this: Owner,
      input: string,
      callback: (value: string | number) => void,
    ): string;
    function providerCall(
      this: Owner,
      input: number,
      callback: (value: string | number) => void,
    ): number;
    function providerCall(
      this: Owner,
      input: string | number,
      callback: (value: string | number) => void,
    ): string | number {
      calls.push({ owner: this, input, callback });
      callback(input);
      return input;
    }
    const OverloadedPlugin = plugin({
      id: "provider-overloaded",
      events: { calls: OverloadedCall },
      instrument({ events, observe }) {
        return (fn: typeof providerCall): typeof providerCall =>
          observe(events.calls, fn);
      },
    });
    const Request = event({
      id: "http.overloaded_request",
      version: 1,
      schema: z.object({}),
      tree: { provider: OverloadedPlugin.events },
    });
    const observed = OverloadedPlugin(providerCall);
    const target = Object.assign(owner, { providerCall: observed });
    const callbackValues: Array<string | number> = [];
    const firstCallback = (value: string | number) =>
      callbackValues.push(value);
    const secondCallback = (value: string | number) =>
      callbackValues.push(value);
    const delivered: SinkRecord[] = [];
    init({
      service: "orders-api",
      env: "test",
      sinks: [(record) => delivered.push(record)],
    });
    const run = Request.handle(() => {
      const stringResult: string = target.providerCall("first", firstCallback);
      const numberResult: number = target.providerCall(2, secondCallback);
      return { numberResult, stringResult };
    });

    expect(run()).toEqual({ stringResult: "first", numberResult: 2 });
    expect(callbackValues).toEqual(["first", 2]);
    expect(calls).toEqual([
      { owner, input: "first", callback: firstCallback },
      { owner, input: 2, callback: secondCallback },
    ]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      provider: { calls: [{ success: true }, { success: true }] },
    });
  });

  it("observe() preserves native Promise, fulfillment, and rejection identity", async () => {
    const delivered: SinkRecord[] = [];
    init({
      service: "orders-api",
      env: "test",
      sinks: [(record) => delivered.push(record)],
    });

    const result = { provider_id: "provider_2" };
    const fulfillment = Promise.resolve(result);
    const observedSuccess = ProviderPlugin(() => fulfillment);
    const successfulRequest = RequestWithProvider.handle(
      () => observedSuccess({ operation: "create_async" }),
      { input: () => ({ request_id: "req_async_success" }) },
    );

    const returnedFulfillment = successfulRequest();
    expect(returnedFulfillment).toBe(fulfillment);
    await expect(returnedFulfillment).resolves.toBe(result);

    const rejection = Object.freeze({ code: "provider_rejected" });
    const rejected = Promise.reject(rejection);
    const observedFailure = ProviderPlugin(() => rejected);
    const failingRequest = RequestWithProvider.handle(
      () => observedFailure({ operation: "delete_async" }),
      { input: () => ({ request_id: "req_async_failure" }) },
    );

    const returnedRejection = failingRequest();
    expect(returnedRejection).toBe(rejected);
    await expect(returnedRejection).rejects.toBe(rejection);

    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toMatchObject({
      request_id: "req_async_success",
      provider: {
        calls: [{ operation: "create_async", success: true }],
      },
    });
    expect(delivered[1]).toMatchObject({
      request_id: "req_async_failure",
      success: false,
      provider: {
        calls: [{ operation: "delete_async", success: false }],
      },
    });
  });

  it("observe() returns a Promise subclass when its species blocks telemetry", () => {
    const delivered: SinkRecord[] = [];
    init({
      service: "orders-api",
      env: "test",
      sinks: [(record) => delivered.push(record)],
    });
    const speciesFailure = Object.freeze({ source: "hostile_species" });
    class HostileSpeciesPromise<T> extends Promise<T> {
      static get [Symbol.species](): PromiseConstructor {
        throw speciesFailure;
      }
    }
    const applicationPromise = new HostileSpeciesPromise<{ accepted: true }>(
      (resolve) => resolve({ accepted: true }),
    );
    const observed = ProviderPlugin(() => applicationPromise);
    const applicationResult = { status: 202 };
    const request = RequestWithProvider.handle(
      () => {
        expect(observed({ operation: "hostile_species" })).toBe(
          applicationPromise,
        );
        return applicationResult;
      },
      { input: () => ({ request_id: "req_hostile_species" }) },
    );

    expect(request()).toBe(applicationResult);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      request_id: "req_hostile_species",
      success: true,
      "@amplio": {
        instrumentation_failure: true,
        diagnostics: [
          expect.objectContaining({
            code: "promise_observation_failed",
            event: "provider.call",
          }),
        ],
      },
    });
    expect(delivered[0]?.provider).toBeUndefined();
  });

  it("begin() reserves occurrence order and returns an idempotent contextual handle", async () => {
    const delivered: SinkRecord[] = [];
    init({
      service: "orders-api",
      env: "test",
      sinks: [(record) => delivered.push(record)],
    });

    const applicationResult = { accepted: true };
    const runResult = { source: "run" };
    const boundResult = { source: "bind" };
    const lateResult = { source: "late" };
    const failed = new Error("provider declined the attempt");
    const callbackOwner = { prefix: "bound" };

    const handleRequest = RequestWithPayment.handle(
      async () => {
        const first = PaymentPlugin({
          attempt: 1,
          state: { phase: "reserved" },
        });
        const second = PaymentPlugin({
          attempt: 2,
          state: { phase: "reserved" },
        });
        const third = PaymentPlugin({
          attempt: 3,
          state: { phase: "reserved" },
        });

        expect(
          first.run(() => {
            AttemptStepPlugin("first:run");
            return runResult;
          }),
        ).toBe(runResult);

        const bound = second.bind(function (
          this: typeof callbackOwner,
          suffix: string,
        ) {
          AttemptStepPlugin(`${this.prefix}:${suffix}`);
          return boundResult;
        });
        await Promise.resolve();
        expect(bound.call(callbackOwner, "callback")).toBe(boundResult);

        first.update({ state: { phase: "running" } });

        // Completion order intentionally differs from reservation order.
        second.fail(failed, { state: { outcome: "failed" } });
        third.cancel("provider_aborted");
        first.end({ state: { outcome: "completed" } });

        // Every settlement method is idempotent and late writes are inert.
        first.update({ attempt: 999 });
        first.fail(new Error("late failure"), { attempt: 999 });
        second.end({ attempt: 999 });
        third.end({ attempt: 999 }, { success: true });
        expect(
          first.run(() => {
            AttemptStepPlugin("first:late");
            return lateResult;
          }),
        ).toBe(lateResult);

        return applicationResult;
      },
      { input: () => ({ request_id: "req_payment" }) },
    );

    await expect(handleRequest()).resolves.toBe(applicationResult);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      request_id: "req_payment",
      success: true,
      payment: {
        attempts: [
          {
            attempt: 1,
            state: { phase: "running", outcome: "completed" },
            success: true,
            work: { steps: [{ label: "first:run" }] },
          },
          {
            attempt: 2,
            state: { phase: "reserved", outcome: "failed" },
            success: false,
            work: { steps: [{ label: "bound:callback" }] },
          },
          {
            attempt: 3,
            state: { phase: "reserved" },
            success: false,
            error: { type: "Error", code: "provider_aborted" },
          },
        ],
      },
    });
  });

  it("begin() can retain parent delivery without delaying the application return", () => {
    const delivered: SinkRecord[] = [];
    init({
      service: "stream-api",
      env: "test",
      sinks: [(record) => delivered.push(record)],
    });

    let observation!: ReturnType<typeof RetainedPlugin>;
    const applicationResult = { stream: "identity" };
    const request = RequestWithRetainedCall.handle(
      () => {
        observation = RetainedPlugin();
        return applicationResult;
      },
      { input: () => ({ request_id: "req_retained" }) },
    );

    expect(request()).toBe(applicationResult);
    expect(delivered).toEqual([]);

    observation.end();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      request_id: "req_retained",
      provider: {
        calls: [{ operation: "stream", success: true }],
      },
      success: true,
    });
  });

  it("bounds retained parent delivery by the nested Event deadline", () => {
    vi.useFakeTimers();
    try {
      const delivered: SinkRecord[] = [];
      init({
        service: "stream-api",
        env: "test",
        sinks: [(record) => delivered.push(record)],
        eventRuntime: { limits: { maxEventDurationMs: 25 } },
      });

      const request = RequestWithRetainedCall.handle(
        () => {
          RetainedPlugin();
          return { stream: "never-settled" };
        },
        { input: () => ({ request_id: "req_retained_timeout" }) },
      );

      expect(request()).toEqual({ stream: "never-settled" });
      expect(delivered).toEqual([]);
      vi.runAllTimers();
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({
        request_id: "req_retained_timeout",
        provider: {
          calls: [
            {
              operation: "stream",
              success: false,
              error: { type: "Error", code: "event_timeout" },
            },
          ],
        },
        success: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("all tools are application-safe and inert outside a declaring root", () => {
    expect(() =>
      AuthPlugin({ method: "password", user_id: "outside" }),
    ).not.toThrow();

    const observedResult = { provider_id: "outside" };
    const observed = ProviderPlugin(() => observedResult);
    expect(observed({ operation: "outside" })).toBe(observedResult);

    const inert = PaymentPlugin({
      attempt: 1,
      state: { phase: "outside" },
    });
    const runResult = { source: "outside-run" };
    expect(inert.run(() => runResult)).toBe(runResult);

    const thrown = Object.freeze({ code: "outside_thrown" });
    let caught: unknown;
    try {
      inert.run(() => {
        throw thrown;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(thrown);

    const owner = { prefix: "outside" };
    const boundResult = { source: "outside-bind" };
    const bound = inert.bind(function (this: typeof owner, suffix: string) {
      expect(this).toBe(owner);
      expect(suffix).toBe("callback");
      return boundResult;
    });
    expect(bound.call(owner, "callback")).toBe(boundResult);
    expect(() => {
      inert.update({ state: { phase: "ignored" } });
      inert.end({ state: { outcome: "ignored" } });
      inert.fail(new Error("ignored"));
      inert.cancel("ignored");
    }).not.toThrow();

    const delivered: SinkRecord[] = [];
    const diagnostics: Array<{ code: string; event?: string }> = [];
    init({
      service: "orders-api",
      env: "test",
      sinks: [(record) => delivered.push(record)],
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    const applicationResult = { status: 200 };
    const plainHandler = PlainRequest.handle(
      () => {
        AuthPlugin({ method: "password", user_id: "undeclared" });
        expect(observed({ operation: "undeclared" })).toBe(observedResult);
        const undeclared = PaymentPlugin({
          attempt: 2,
          state: { phase: "undeclared" },
        });
        expect(
          undeclared.run(() => {
            AttemptStepPlugin("undeclared-child");
            return applicationResult;
          }),
        ).toBe(applicationResult);
        undeclared.update({ state: { phase: "ignored" } });
        undeclared.end({ state: { outcome: "ignored" } });
        return applicationResult;
      },
      { input: () => ({ request_id: "req_plain" }) },
    );

    expect(plainHandler()).toBe(applicationResult);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      "@event": "http.plain_request",
      request_id: "req_plain",
      success: true,
    });
    expect(delivered[0]).not.toHaveProperty("auth");
    expect(delivered[0]).not.toHaveProperty("provider");
    expect(delivered[0]).not.toHaveProperty("payment");
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "event_unmounted",
          event: "auth.signed_in",
        }),
        expect.objectContaining({
          code: "event_unmounted",
          event: "provider.call",
        }),
        expect.objectContaining({
          code: "event_unmounted",
          event: "payment.attempt",
        }),
      ]),
    );
  });

  it("preserves provider behavior when the default diagnostic console throws", () => {
    const consoleFailure = Object.freeze({ source: "hostile_console" });
    const result = { provider_id: "provider_console" };
    let calls = 0;
    const observed = HostileConsolePlugin((operation) => {
      calls += 1;
      expect(operation).toBe("outside");
      return result;
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {
      throw consoleFailure;
    });

    try {
      expect(observed("outside")).toBe(result);
      expect(calls).toBe(1);
    } finally {
      warning.mockRestore();
    }
  });

  it("preserves provider behavior when the diagnostic clock throws", () => {
    const clockFailure = Object.freeze({ source: "hostile_clock" });
    const result = { provider_id: "provider_clock" };
    let calls = 0;
    const observed = HostileClockPlugin(() => {
      calls += 1;
      return result;
    });
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      throw clockFailure;
    });

    try {
      expect(observed("outside")).toBe(result);
      expect(calls).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });
});
