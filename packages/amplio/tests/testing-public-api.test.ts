import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { event, init, type SinkRecord } from "../src/index.js";
import { assertEvent, createTestSink } from "../src/testing.js";
import pkg from "../package.json" with { type: "json" };

const packageRoot = path.resolve(import.meta.dirname, "..");
const typeFixtureConfig = path.join(
  packageRoot,
  "tests/fixtures/testing-public-api/tsconfig.json",
);

const Checkout = event({
  id: "test.checkout",
  version: 1,
  schema: z.object({ checkout_id: z.string() }),
});

const SharedIdentitySchema = z.object({ source: z.string() });
const FirstSharedIdentity = event({
  id: "test.shared_identity",
  version: 1,
  schema: SharedIdentitySchema,
});
const SecondSharedIdentity = event({
  id: "test.shared_identity",
  version: 1,
  schema: SharedIdentitySchema,
});
const UnobservedSharedIdentity = event({
  id: "test.shared_identity",
  version: 1,
  schema: SharedIdentitySchema,
});

const DiagnosticEvent = event({
  id: "test.diagnostic",
  version: 1,
  schema: z.object({}),
});

const errorMessage = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected operation to throw");
};

describe("testing public API", () => {
  it("preserves exact EventRecord inference through the testing subpath", () => {
    execFileSync("pnpm", ["exec", "tsc", "-p", typeFixtureConfig], {
      cwd: packageRoot,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: "pipe",
    });

    expect(true).toBe(true);
  }, 15_000);

  it("captures one typed Event record through a normal configured sink", () => {
    const events = createTestSink();
    init({ service: "store-test", env: "test", sinks: [events] });

    const applicationResult = { status: 201 };
    const checkout = Checkout.handle(() => applicationResult, {
      input: () => ({ checkout_id: "checkout_1" }),
    });

    expect(checkout()).toBe(applicationResult);
    expect(events.single(Checkout)).toMatchObject({
      "@event": "test.checkout",
      "@event_version": 1,
      checkout_id: "checkout_1",
      service: "store-test",
      env: "test",
      success: true,
    });
  });

  it("selects records by exact Event identity, even when IDs are equal", () => {
    const events = createTestSink();
    init({ service: "identity-test", env: "test", sinks: [events] });

    const first = FirstSharedIdentity.handle(() => undefined, {
      input: () => ({ source: "first" }),
    });
    const second = SecondSharedIdentity.handle(() => undefined, {
      input: () => ({ source: "second" }),
    });
    first();
    second();

    expect(events.all(FirstSharedIdentity)).toHaveLength(1);
    expect(events.single(FirstSharedIdentity).source).toBe("first");
    expect(events.all(SecondSharedIdentity)).toHaveLength(1);
    expect(events.single(SecondSharedIdentity).source).toBe("second");
    expect(events.all(UnobservedSharedIdentity)).toEqual([]);
  });

  it("single() explains zero and multiple matches without affecting capture", () => {
    const events = createTestSink();
    init({ service: "cardinality-test", env: "test", sinks: [events] });

    const zeroMessage = errorMessage(() => events.single(Checkout));
    expect(zeroMessage).toContain("test.checkout");
    expect(zeroMessage).toContain("0");

    const checkout = Checkout.handle(() => undefined, {
      input: (context) => ({ checkout_id: String(context.args[0]) }),
    });
    checkout("first");
    checkout("second");

    const multipleMessage = errorMessage(() => events.single(Checkout));
    expect(multipleMessage).toContain("test.checkout");
    expect(multipleMessage).toContain("2");
    expect(events.all(Checkout).map((record) => record.checkout_id)).toEqual([
      "first",
      "second",
    ]);
  });

  it("clear() resets captured records and diagnostics while keeping the sink usable", () => {
    const events = createTestSink();
    init({ service: "clear-test", env: "test", sinks: [events] });

    const checkout = Checkout.handle(() => undefined, {
      input: (context) => ({ checkout_id: String(context.args[0]) }),
    });
    checkout("before_clear");
    expect(events.all(Checkout)).toHaveLength(1);

    events.clear();
    expect(events.all(Checkout)).toEqual([]);
    expect(events.diagnostics).toEqual([]);
    expect(() => events.assertNoDiagnostics()).not.toThrow();

    checkout("after_clear");
    expect(events.single(Checkout).checkout_id).toBe("after_clear");
  });

  it("collects runtime diagnostics and reports them explicitly on demand", () => {
    const events = createTestSink();
    init({ service: "diagnostic-test", env: "test", sinks: [events] });

    const applicationResult = { status: "ok" };
    const instrumented = DiagnosticEvent.handle(() => applicationResult, {
      input: () => {
        throw new Error("projector implementation detail");
      },
    });

    expect(instrumented()).toBe(applicationResult);
    expect(events.diagnostics).toEqual([
      expect.objectContaining({
        code: "projection_failed",
        event: "test.diagnostic",
      }),
    ]);

    const message = errorMessage(() => events.assertNoDiagnostics());
    expect(message).toContain("projection_failed");
    expect(message).toContain("test.diagnostic");
  });

  it("captures out-of-band failures even when no Event reaches the sink", () => {
    const events = createTestSink();
    init({
      service: "diagnostic-test",
      env: "test",
      redactor() {
        throw new Error("privacy stage failed");
      },
      sinks: [events],
    });

    expect(DiagnosticEvent.handle(() => "application-result")()).toBe(
      "application-result",
    );
    expect(events.all(DiagnosticEvent)).toEqual([]);
    expect(events.diagnostics).toEqual([
      expect.objectContaining({
        code: "redactor_failed",
        event: "test.diagnostic",
      }),
    ]);
    expect(() => events.assertNoDiagnostics()).toThrow(/redactor_failed/);
  });

  it("assertEvent() validates unknown records and narrows valid records", () => {
    const events = createTestSink();
    init({ service: "assertion-test", env: "test", sinks: [events] });

    const checkout = Checkout.handle(() => undefined, {
      input: () => ({ checkout_id: "checkout_asserted" }),
    });
    checkout();

    const candidate: unknown = events.single(Checkout);
    expect(() => assertEvent(Checkout, candidate)).not.toThrow();
    expect(candidate).toMatchObject({ checkout_id: "checkout_asserted" });

    const invalid = {
      ...(candidate as Record<string, unknown>),
      checkout_id: 42,
    };
    const invalidMessage = errorMessage(() => assertEvent(Checkout, invalid));
    expect(invalidMessage).toContain("test.checkout");
    expect(invalidMessage).toMatch(/checkout_id|schema|invalid/i);

    const wrongEventMessage = errorMessage(() =>
      assertEvent(Checkout, {
        ...(candidate as Record<string, unknown>),
        "@event": "test.another_event",
      }),
    );
    expect(wrongEventMessage).toContain("test.checkout");
    expect(wrongEventMessage).toContain("test.another_event");
  });

  it("assertEvent() accepts delivered schema transforms but rejects incomplete envelopes", () => {
    const Transformed = event({
      id: "test.transformed_assertion",
      version: 1,
      schema: z
        .object({ raw: z.string() })
        .transform(({ raw }) => ({ normalized: raw.toUpperCase() })),
    });
    const events = createTestSink();
    init({ service: "assertion-test", env: "test", sinks: [events] });
    Transformed.handle(() => undefined, {
      input: () => ({ raw: "ready" }),
    })();

    const delivered: unknown = events.single(Transformed);
    expect(() => assertEvent(Transformed, delivered)).not.toThrow();
    expect(delivered).toMatchObject({ normalized: "READY" });

    expect(() =>
      assertEvent(Transformed, {
        "@event": "test.transformed_assertion",
        "@event_version": 1,
        normalized: "READY",
      }),
    ).toThrow(/service|envelope|record/i);
  });

  it("assertEvent() rejects invalid mounted branches and runtime error shapes", () => {
    const Child = event({
      id: "test.assertion_child",
      version: 1,
      schema: z.object({ value: z.string() }),
      timing: "instant",
    });
    const Root = event({
      id: "test.assertion_tree",
      version: 1,
      schema: z.object({ root: z.string() }),
      tree: { nested: { child: Child } },
    });
    const base = {
      "@event": "test.assertion_tree",
      "@event_version": 1,
      service: "test",
      env: "test",
      timestamp: new Date().toISOString(),
      duration_ms: 1,
      success: false,
      root: "ok",
    };

    expect(() =>
      assertEvent(Root, {
        ...base,
        nested: { child: { value: 42 } },
      }),
    ).toThrow(/nested|child|schema|invalid/i);
    expect(() =>
      assertEvent(Root, {
        ...base,
        error: { message: "missing required type" },
      }),
    ).toThrow(/error|type|record/i);
  });

  it("never changes application return, Promise, error, or sink behavior", async () => {
    const events = createTestSink();
    const applicationRecords: SinkRecord[] = [];
    init({
      service: "transparency-test",
      env: "test",
      sinks: [events, (record) => applicationRecords.push(record)],
    });

    const synchronousResult = { status: "sync" };
    const synchronous = Checkout.handle(() => synchronousResult, {
      input: () => ({ checkout_id: "sync" }),
    });
    expect(synchronous()).toBe(synchronousResult);

    const asynchronousResult = { status: "async" };
    const originalPromise = Promise.resolve(asynchronousResult);
    const asynchronous = Checkout.handle(() => originalPromise, {
      input: () => ({ checkout_id: "async" }),
    });
    const returnedPromise = asynchronous();
    expect(returnedPromise).toBe(originalPromise);
    await expect(returnedPromise).resolves.toBe(asynchronousResult);

    const thrown = Object.freeze({ code: "application_error" });
    const failing = Checkout.handle(
      () => {
        throw thrown;
      },
      {
        input: () => ({ checkout_id: "failure" }),
      },
    );
    let caught: unknown;
    try {
      failing();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(thrown);

    expect(applicationRecords).toHaveLength(3);
    expect(events.all(Checkout)).toHaveLength(3);

    // Assertion helpers fail only when explicitly called after application work.
    expect(() => events.single(Checkout)).toThrow();
    expect(applicationRecords).toHaveLength(3);
  });

  it("publishes the testing subpath and its built JavaScript and declarations", () => {
    expect(pkg.exports).toHaveProperty("./testing", {
      import: "./dist/testing.js",
      types: "./dist/testing.d.ts",
    });
    expect(existsSync(path.join(packageRoot, "dist/testing.js"))).toBe(true);
    expect(existsSync(path.join(packageRoot, "dist/testing.d.ts"))).toBe(true);
  });
});
