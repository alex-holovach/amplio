import { execFileSync } from "node:child_process";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import * as core from "../src/index.js";
import { event, init, type SinkRecord } from "../src/index.js";
import { resetConfigForTests } from "../src/legacy.js";
import * as authoring from "../src/plugin.js";
import { openEvent, plugin } from "../src/plugin.js";

const packageRoot = path.resolve(import.meta.dirname, "..");
const typeFixtureConfig = path.join(
  packageRoot,
  "tests/fixtures/open-event-contract/tsconfig.json",
);

const ProviderCall = event({
  id: "provider.call",
  version: 1,
  schema: z.object({ label: z.string() }),
  timing: "duration",
  cardinality: { many: { max: 8 } },
});

const ProviderPlugin = plugin({
  id: "provider",
  events: { calls: ProviderCall },
  instrument({ events, observe }) {
    return <F extends (input: { label: string }, ...args: any[]) => unknown>(
      fn: F,
    ): F =>
      observe(events.calls, fn, {
        input: ({ args: [input] }) => ({ label: input.label }),
      });
  },
});

const HttpRequest = event({
  id: "http.request",
  version: 1,
  schema: z.object({
    request_id: z.string(),
    http: z.object({
      method: z.string(),
      route: z.string(),
      response: z.object({
        status: z.number().int(),
        headers: z.object({
          content_type: z.string(),
          trace_id: z.string(),
        }),
      }),
    }),
    lifecycle: z.object({ phase: z.string() }).optional(),
  }),
  tree: { provider: ProviderPlugin.events },
});

const completeInput = (requestId: string) => ({
  request_id: requestId,
  http: {
    method: "GET",
    route: "/orders/:id",
    response: {
      status: 200,
      headers: {
        content_type: "application/json",
        trace_id: `trace_${requestId}`,
      },
    },
  },
});

const captureEvents = (): SinkRecord[] => {
  const delivered: SinkRecord[] = [];
  init({
    service: "orders-api",
    env: "test",
    sinks: [(record) => delivered.push(record)],
  });
  return delivered;
};

beforeEach(() => {
  resetConfigForTests();
});

describe("openEvent framework-boundary contract", () => {
  it("is authoring-only and accepts only duration Events in its public types", () => {
    expect(authoring).toHaveProperty("openEvent");
    expect(core).not.toHaveProperty("openEvent");

    execFileSync("pnpm", ["exec", "tsc", "-p", typeFixtureConfig], {
      cwd: packageRoot,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: "pipe",
    });
  });

  it("is safe before init and leaves application callbacks transparent", () => {
    const scope = openEvent(HttpRequest, completeInput("pre_init"));
    const runResult = { source: "run" };
    expect(scope.run(() => runResult)).toBe(runResult);

    const owner = { prefix: "pre" };
    const boundResult = { source: "bind" };
    const bound = scope.bind(function (this: typeof owner, suffix: string) {
      expect(this).toBe(owner);
      expect(suffix).toBe("init");
      return boundResult;
    });
    expect(bound.call(owner, "init")).toBe(boundResult);

    expect(() => {
      scope.update({ lifecycle: { phase: "closing" } });
      scope.finish({ lifecycle: { phase: "closed" } });
      scope.fail(new Error("late"));
      scope.cancel("late_cancel");
    }).not.toThrow();

    const delivered = captureEvents();
    expect(delivered).toEqual([]);
  });

  it("run() and bind() preserve behavior while nested Plugin observations attach", () => {
    const delivered = captureEvents();
    const scope = openEvent(HttpRequest, completeInput("callbacks"));
    const owner = { prefix: "native" };
    const runInput = { label: "run" };
    const boundInput = { label: "bind" };
    const calls: Array<{
      owner: typeof owner;
      input: { label: string };
      attempt: number;
    }> = [];
    const providerResult = { provider_id: "provider_1" };
    const callProvider = ProviderPlugin(function (
      this: typeof owner,
      input: { label: string },
      attempt: number,
    ) {
      calls.push({ owner: this, input, attempt });
      return providerResult;
    });

    expect(scope.run(() => callProvider.call(owner, runInput, 1))).toBe(
      providerResult,
    );

    const bound = scope.bind(callProvider);
    expect(bound.call(owner, boundInput, 2)).toBe(providerResult);

    const runThrown = Object.freeze({ code: "run_thrown" });
    let caughtRun: unknown;
    try {
      scope.run(() => {
        throw runThrown;
      });
    } catch (error) {
      caughtRun = error;
    }
    expect(caughtRun).toBe(runThrown);

    const bindThrown = Object.freeze({ code: "bind_thrown" });
    const throwing = scope.bind(function (
      this: typeof owner,
      input: { label: string },
    ) {
      expect(this).toBe(owner);
      expect(input).toBe(boundInput);
      throw bindThrown;
    });
    let caughtBind: unknown;
    try {
      throwing.call(owner, boundInput);
    } catch (error) {
      caughtBind = error;
    }
    expect(caughtBind).toBe(bindThrown);

    scope.finish();

    expect(calls).toEqual([
      { owner, input: runInput, attempt: 1 },
      { owner, input: boundInput, attempt: 2 },
    ]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      request_id: "callbacks",
      provider: {
        calls: [
          { label: "run", success: true },
          { label: "bind", success: true },
        ],
      },
    });
  });

  it("deep-merges root input across update() and finish()", () => {
    const delivered = captureEvents();
    const scope = openEvent(HttpRequest, {
      request_id: "deep_merge",
      http: {
        method: "POST",
        response: {
          headers: { content_type: "application/json" },
        },
      },
    });

    scope.update({
      http: {
        route: "/orders",
        response: { status: 201 },
      },
      lifecycle: { phase: "responding" },
    });
    scope.finish({
      http: {
        response: { headers: { trace_id: "trace_deep_merge" } },
      },
      lifecycle: { phase: "finished" },
    });

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      request_id: "deep_merge",
      http: {
        method: "POST",
        route: "/orders",
        response: {
          status: 201,
          headers: {
            content_type: "application/json",
            trace_id: "trace_deep_merge",
          },
        },
      },
      lifecycle: { phase: "finished" },
    });
  });

  it("settles once across finish(), fail(), and cancel() without throwing", () => {
    const delivered = captureEvents();
    const finished = openEvent(HttpRequest, completeInput("finished"));
    const failed = openEvent(HttpRequest, completeInput("failed"));
    const cancelled = openEvent(HttpRequest, completeInput("cancelled"));

    finished.finish({ lifecycle: { phase: "first_finish" } });
    finished.finish({ lifecycle: { phase: "late_finish" } });
    finished.fail(new Error("late failure"));

    const applicationError = Object.assign(
      new Error("sensitive framework failure"),
      { code: "framework_failed" },
    );
    expect(() =>
      failed.fail(applicationError, {
        lifecycle: { phase: "first_failure" },
      }),
    ).not.toThrow();
    failed.cancel("late_cancel");
    failed.finish({ lifecycle: { phase: "late_finish" } });

    expect(() => cancelled.cancel("framework_cancelled")).not.toThrow();
    cancelled.fail(new Error("late failure"));
    cancelled.finish({ lifecycle: { phase: "late_finish" } });

    expect(delivered).toHaveLength(3);
    expect(delivered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          request_id: "finished",
          lifecycle: { phase: "first_finish" },
          success: true,
        }),
        expect.objectContaining({
          request_id: "failed",
          lifecycle: { phase: "first_failure" },
          success: false,
          error: { type: "Error" },
        }),
        expect.objectContaining({
          request_id: "cancelled",
          success: false,
          error: { type: "Error", code: "framework_cancelled" },
        }),
      ]),
    );

    const failedRecord = delivered.find(
      (record) => record.request_id === "failed",
    );
    expect(failedRecord?.error).toEqual({
      type: "Error",
    });
  });

  it("preserves the caller's thrown value when framework code reports failure", () => {
    const delivered = captureEvents();
    const scope = openEvent(HttpRequest, completeInput("throw_identity"));
    const thrown = Object.freeze({ code: "application_thrown" });

    const frameworkBoundary = (): never => {
      try {
        return scope.run(() => {
          throw thrown;
        });
      } catch (error) {
        scope.fail(error);
        throw error;
      }
    };

    let caught: unknown;
    try {
      frameworkBoundary();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(thrown);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      request_id: "throw_identity",
      success: false,
      error: { type: "NonError" },
    });
  });

  it("isolates interleaved scopes of the same root Event", async () => {
    const delivered = captureEvents();
    const first = openEvent(HttpRequest, completeInput("first"));
    const second = openEvent(HttpRequest, completeInput("second"));
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const callProvider = ProviderPlugin((input: { label: string }) => input);

    const firstWork = first.run(async () => {
      await firstGate;
      callProvider({ label: "first_only" });
      first.update({ lifecycle: { phase: "first_done" } });
    });
    const secondWork = second.run(async () => {
      await secondGate;
      callProvider({ label: "second_only" });
      second.update({ lifecycle: { phase: "second_done" } });
    });

    releaseSecond();
    await secondWork;
    second.finish();
    releaseFirst();
    await firstWork;
    first.finish();

    expect(delivered).toHaveLength(2);
    expect(
      delivered.find((record) => record.request_id === "first"),
    ).toMatchObject({
      lifecycle: { phase: "first_done" },
      provider: { calls: [{ label: "first_only" }] },
    });
    expect(
      delivered.find((record) => record.request_id === "second"),
    ).toMatchObject({
      lifecycle: { phase: "second_done" },
      provider: { calls: [{ label: "second_only" }] },
    });
  });

  it("does not double-emit when the same root handle re-enters a scope", () => {
    const delivered = captureEvents();
    let projectorCalls = 0;
    const applicationResult = { status: 204 };
    const callProvider = ProviderPlugin((input: { label: string }) => input);
    const nestedHandle = HttpRequest.handle(
      () => {
        callProvider({ label: "inside_handle" });
        return applicationResult;
      },
      {
        input: () => {
          projectorCalls += 1;
          return { request_id: "inner" };
        },
        result: () => {
          projectorCalls += 1;
          return { lifecycle: { phase: "inner" } };
        },
      },
    );
    const scope = openEvent(HttpRequest, completeInput("outer"));

    expect(scope.run(() => nestedHandle())).toBe(applicationResult);
    scope.finish();

    expect(projectorCalls).toBe(0);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      request_id: "outer",
      provider: { calls: [{ label: "inside_handle" }] },
    });
  });
});
