import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  event,
  init,
  type EventDefinition,
  type SinkRecord,
} from "../src/index.js";
import { openEvent, plugin } from "../src/plugin.js";

type Cardinality = "single" | { many: { max: number } };
type TestEventTree = {
  readonly [key: string]: EventDefinition | TestEventTree;
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

const collectRecords = (): SinkRecord[] => {
  const records: SinkRecord[] = [];
  init({
    service: "event-occurrence-contract",
    env: "test",
    sinks: [(record) => records.push(record)],
  });
  return records;
};

const createDurationPlugin = (options: {
  eventId: string;
  pluginId: string;
  cardinality: Cardinality;
  tree?: TestEventTree;
}) => {
  const Call = event({
    id: options.eventId,
    version: 1,
    schema: z.object({ label: z.string() }),
    timing: "duration",
    cardinality: options.cardinality,
    tree: options.tree ?? {},
  });
  const CallPlugin = plugin({
    id: options.pluginId,
    events: { calls: Call },
    instrument({ events, observe }) {
      return <F extends (input: { label: string }) => unknown>(fn: F): F =>
        observe(events.calls, fn, {
          input: ({ args: [input] }) => ({ label: input.label }),
        });
    },
  });
  return { Call, CallPlugin };
};

const createInstantPlugin = (options: {
  eventId: string;
  pluginId: string;
  max?: number;
}) => {
  const Entry = event({
    id: options.eventId,
    version: 1,
    schema: z.object({ label: z.string() }),
    timing: "instant",
    cardinality: { many: { max: options.max ?? 16 } },
  });
  const EntryPlugin = plugin({
    id: options.pluginId,
    events: { entries: Entry },
    instrument({ events, record }) {
      return (label: string): void => record(events.entries, { label });
    },
  });
  return { Entry, EntryPlugin };
};

const createRoot = (id: string, tree: TestEventTree) =>
  event({
    id,
    version: 1,
    schema: z.object({ marker: z.string().optional() }),
    tree,
  });

const recordFor = (records: SinkRecord[], eventId: string): SinkRecord => {
  const record = records.find((candidate) => candidate["@event"] === eventId);
  expect(record, `missing delivered Event ${eventId}`).toBeDefined();
  return record!;
};

describe("Event occurrence lifecycle", () => {
  it("keeps repeated duration occurrences in invocation order when they complete in reverse", async () => {
    const { CallPlugin } = createDurationPlugin({
      eventId: "provider.ordered_call",
      pluginId: "provider-ordered-call",
      cardinality: { many: { max: 3 } },
    });
    const Root = createRoot("request.ordered_calls", {
      provider: CallPlugin.events,
    });
    const records = collectRecords();
    const gates = new Map(
      ["first", "second", "third"].map((label) => [label, deferred()]),
    );
    const invoked: string[] = [];
    const call = CallPlugin(({ label }) => {
      invoked.push(label);
      return gates.get(label)!.promise;
    });
    const run = Root.handle(async () => {
      const first = call({ label: "first" });
      const second = call({ label: "second" });
      const third = call({ label: "third" });

      gates.get("third")!.resolve();
      await third;
      gates.get("second")!.resolve();
      await second;
      gates.get("first")!.resolve();
      await first;
    });

    await run();

    expect(invoked).toEqual(["first", "second", "third"]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: {
        calls: [
          { label: "first", success: true },
          { label: "second", success: true },
          { label: "third", success: true },
        ],
      },
    });
  });

  it("lets the first single reservation win and diagnoses duplicates exactly once", async () => {
    const { CallPlugin } = createDurationPlugin({
      eventId: "provider.single_call",
      pluginId: "provider-single-call",
      cardinality: "single",
    });
    const Root = createRoot("request.single_call", {
      provider: CallPlugin.events,
    });
    const records = collectRecords();
    const gates = new Map(
      ["first", "duplicate_one", "duplicate_two"].map((label) => [
        label,
        deferred(),
      ]),
    );
    const invoked: string[] = [];
    const call = CallPlugin(({ label }) => {
      invoked.push(label);
      return gates.get(label)!.promise;
    });
    const run = Root.handle(async () => {
      const first = call({ label: "first" });
      const duplicateOne = call({ label: "duplicate_one" });
      const duplicateTwo = call({ label: "duplicate_two" });

      gates.get("duplicate_two")!.resolve();
      gates.get("duplicate_one")!.resolve();
      await Promise.all([duplicateOne, duplicateTwo]);
      gates.get("first")!.resolve();
      await first;
    });

    await run();

    expect(invoked).toEqual(["first", "duplicate_one", "duplicate_two"]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: { calls: { label: "first", success: true } },
    });
    expect(records[0]?.["@amplio"]).toEqual({
      diagnostics: [
        {
          code: "duplicate_single",
          path: ["provider", "calls"],
          event: "provider.single_call",
          count: 1,
        },
      ],
    });
  });

  it("accepts the first max reservations, drops newest overflow, and reports exact truncation", async () => {
    const { CallPlugin } = createDurationPlugin({
      eventId: "provider.bounded_call",
      pluginId: "provider-bounded-call",
      cardinality: { many: { max: 2 } },
    });
    const Root = createRoot("request.bounded_calls", {
      provider: CallPlugin.events,
    });
    const records = collectRecords();
    const labels = ["first", "second", "overflow_one", "overflow_two"];
    const gates = new Map(labels.map((label) => [label, deferred()]));
    const invoked: string[] = [];
    const call = CallPlugin(({ label }) => {
      invoked.push(label);
      return gates.get(label)!.promise;
    });
    const run = Root.handle(async () => {
      const calls = labels.map((label) => call({ label }));
      for (const label of [...labels].reverse()) gates.get(label)!.resolve();
      await Promise.all(calls);
    });

    await run();

    expect(invoked).toEqual(labels);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: {
        calls: [{ label: "first" }, { label: "second" }],
      },
    });
    expect(JSON.stringify(records[0])).not.toContain("overflow_one");
    expect(JSON.stringify(records[0])).not.toContain("overflow_two");
    expect(records[0]?.["@amplio"]).toEqual({
      truncated: [
        {
          path: ["provider", "calls"],
          max: 2,
          dropped: 2,
        },
      ],
    });
  });

  it("omits a pending child, diagnoses it, and cannot mutate the delivered snapshot after late completion", async () => {
    const { CallPlugin } = createDurationPlugin({
      eventId: "provider.pending_call",
      pluginId: "provider-pending-call",
      cardinality: { many: { max: 2 } },
    });
    const Root = createRoot("request.pending_call", {
      provider: CallPlugin.events,
    });
    const records = collectRecords();
    const late = deferred();
    const call = CallPlugin(() => late.promise);
    const run = Root.handle(() => {
      void call({ label: "late" });
    });

    run();

    expect(records).toHaveLength(1);
    expect(records[0]).not.toHaveProperty("provider");
    expect(records[0]?.["@amplio"]).toEqual({
      incomplete: [
        {
          path: ["provider", "calls", 0],
          event: "provider.pending_call",
          pending: 1,
        },
      ],
    });
    expect(Object.isFrozen(records[0])).toBe(true);
    const delivered = records[0];
    const snapshot = JSON.stringify(delivered);

    late.resolve();
    await late.promise;
    await Promise.resolve();

    expect(records).toHaveLength(1);
    expect(records[0]).toBe(delivered);
    expect(JSON.stringify(records[0])).toBe(snapshot);
  });

  it("isolates child Events inside each repeated duration parent occurrence", async () => {
    const { EntryPlugin: StepPlugin } = createInstantPlugin({
      eventId: "provider.parent_step",
      pluginId: "provider-parent-step",
    });
    const { CallPlugin: ParentPlugin } = createDurationPlugin({
      eventId: "provider.parent_call",
      pluginId: "provider-parent-call",
      cardinality: { many: { max: 2 } },
      tree: { work: StepPlugin.events },
    });
    const Root = createRoot("request.parent_calls", {
      parents: ParentPlugin.events,
    });
    const records = collectRecords();
    const firstGate = deferred();
    const secondGate = deferred();
    const parent = ParentPlugin(async ({ label }) => {
      StepPlugin(`${label}:before`);
      await (label === "first" ? firstGate.promise : secondGate.promise);
      StepPlugin(`${label}:after`);
    });
    const run = Root.handle(async () => {
      const first = parent({ label: "first" });
      const second = parent({ label: "second" });

      secondGate.resolve();
      await second;
      firstGate.resolve();
      await first;
    });

    await run();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      parents: {
        calls: [
          {
            label: "first",
            work: {
              entries: [{ label: "first:before" }, { label: "first:after" }],
            },
          },
          {
            label: "second",
            work: {
              entries: [{ label: "second:before" }, { label: "second:after" }],
            },
          },
        ],
      },
    });
    expect(JSON.stringify(records[0]?.parents)).not.toContain(
      '"label":"first:before"},{"label":"second',
    );
  });

  it("keeps a child inert when its declared semantic parent has no occurrence", () => {
    const { EntryPlugin: StepPlugin } = createInstantPlugin({
      eventId: "provider.orphan_step",
      pluginId: "provider-orphan-step",
    });
    const { CallPlugin: ParentPlugin } = createDurationPlugin({
      eventId: "provider.orphan_parent",
      pluginId: "provider-orphan-parent",
      cardinality: "single",
      tree: { work: StepPlugin.events },
    });
    const Root = createRoot("request.orphan_child", {
      parents: ParentPlugin.events,
    });
    const records: SinkRecord[] = [];
    const diagnostics: Array<{ code: string; event?: string }> = [];
    init({
      service: "event-occurrence-contract",
      env: "test",
      sinks: [(record) => records.push(record)],
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const run = Root.handle(() => StepPlugin("orphan"), {
      input: () => ({ marker: "root" }),
    });

    run();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ marker: "root" });
    expect(records[0]).not.toHaveProperty("parents");
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "event_unmounted",
        event: "provider.orphan_step",
      }),
    ]);
  });

  it.each([
    ["duplicate single", "single" as const],
    ["repeated overflow", { many: { max: 1 } } as const],
  ])(
    "executes a rejected %s occurrence in a shadow frame so descendants cannot leak",
    async (scenario, cardinality) => {
      const suffix = scenario === "duplicate single" ? "duplicate" : "overflow";
      const { EntryPlugin: ChildPlugin } = createInstantPlugin({
        eventId: `shadow.${suffix}_child`,
        pluginId: `shadow-${suffix}-child`,
      });
      const { CallPlugin: ParentPlugin } = createDurationPlugin({
        eventId: `shadow.${suffix}_parent`,
        pluginId: `shadow-${suffix}-parent`,
        cardinality,
        tree: { work: ChildPlugin.events },
      });
      const Root = createRoot(`request.${suffix}_shadow`, {
        parents: ParentPlugin.events,
      });
      const records = collectRecords();
      const firstGate = deferred();
      const rejectedGate = deferred();
      const invoked: string[] = [];
      const parent = ParentPlugin(({ label }) => {
        invoked.push(label);
        ChildPlugin(`${label}:child`);
        return label === "first" ? firstGate.promise : rejectedGate.promise;
      });
      const run = Root.handle(async () => {
        const first = parent({ label: "first" });
        const rejected = parent({ label: "rejected" });

        rejectedGate.resolve();
        await rejected;
        firstGate.resolve();
        await first;
      });

      await run();

      expect(invoked).toEqual(["first", "rejected"]);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject(
        cardinality === "single"
          ? {
              parents: {
                calls: {
                  label: "first",
                  work: { entries: [{ label: "first:child" }] },
                },
              },
            }
          : {
              parents: {
                calls: [
                  {
                    label: "first",
                    work: { entries: [{ label: "first:child" }] },
                  },
                ],
              },
            },
      );
      expect(JSON.stringify(records[0])).not.toContain("rejected:child");
    },
  );

  it("isolates interleaved root Events", async () => {
    const { EntryPlugin: ActivityPlugin } = createInstantPlugin({
      eventId: "activity.interleaved_entry",
      pluginId: "activity-interleaved-entry",
    });
    const RootA = createRoot("request.interleaved_a", {
      activity: ActivityPlugin.events,
    });
    const RootB = createRoot("request.interleaved_b", {
      activity: ActivityPlugin.events,
    });
    const records = collectRecords();
    const gateA = deferred();
    const gateB = deferred();
    const runA = RootA.handle(
      async () => {
        ActivityPlugin("a:before");
        await gateA.promise;
        ActivityPlugin("a:after");
      },
      { input: () => ({ marker: "a" }) },
    );
    const runB = RootB.handle(
      async () => {
        ActivityPlugin("b:before");
        await gateB.promise;
        ActivityPlugin("b:after");
      },
      { input: () => ({ marker: "b" }) },
    );

    const a = runA();
    const b = runB();
    gateB.resolve();
    await b;
    gateA.resolve();
    await a;

    expect(records).toHaveLength(2);
    expect(recordFor(records, "request.interleaved_a")).toMatchObject({
      marker: "a",
      activity: {
        entries: [{ label: "a:before" }, { label: "a:after" }],
      },
    });
    expect(recordFor(records, "request.interleaved_b")).toMatchObject({
      marker: "b",
      activity: {
        entries: [{ label: "b:before" }, { label: "b:after" }],
      },
    });
    expect(
      JSON.stringify(recordFor(records, "request.interleaved_a")),
    ).not.toContain("b:");
    expect(
      JSON.stringify(recordFor(records, "request.interleaved_b")),
    ).not.toContain("a:");
  });

  it("keeps bound callbacks on their original root while unbound callbacks follow the ambient root", () => {
    const { EntryPlugin: ActivityPlugin } = createInstantPlugin({
      eventId: "activity.retained_callback_entry",
      pluginId: "activity-retained-callback-entry",
    });
    const RootA = createRoot("request.callback_root_a", {
      activity: ActivityPlugin.events,
    });
    const RootB = createRoot("request.callback_root_b", {
      activity: ActivityPlugin.events,
    });
    const records = collectRecords();
    const scopeA = openEvent(RootA, { marker: "a" });
    const boundToA = scopeA.bind(() => ActivityPlugin("bound:a"));
    const unbound = () => ActivityPlugin("ambient:b");
    const runB = RootB.handle(
      () => {
        boundToA();
        unbound();
      },
      { input: () => ({ marker: "b" }) },
    );

    runB();
    scopeA.finish();

    expect(records).toHaveLength(2);
    expect(recordFor(records, "request.callback_root_a")).toMatchObject({
      marker: "a",
      activity: { entries: [{ label: "bound:a" }] },
    });
    expect(recordFor(records, "request.callback_root_b")).toMatchObject({
      marker: "b",
      activity: { entries: [{ label: "ambient:b" }] },
    });
    expect(
      JSON.stringify(recordFor(records, "request.callback_root_a")),
    ).not.toContain("ambient:b");
    expect(
      JSON.stringify(recordFor(records, "request.callback_root_b")),
    ).not.toContain("bound:a");
  });

  it("gives a different nested root an independent record and restores the outer root", () => {
    const { EntryPlugin: ActivityPlugin } = createInstantPlugin({
      eventId: "activity.nested_root_entry",
      pluginId: "activity-nested-root-entry",
    });
    const Outer = createRoot("request.outer_root", {
      activity: ActivityPlugin.events,
    });
    const Inner = createRoot("request.inner_root", {
      activity: ActivityPlugin.events,
    });
    const records = collectRecords();
    const runInner = Inner.handle(() => ActivityPlugin("inner"), {
      input: () => ({ marker: "inner" }),
    });
    const runOuter = Outer.handle(
      () => {
        ActivityPlugin("outer:before");
        runInner();
        ActivityPlugin("outer:after");
      },
      { input: () => ({ marker: "outer" }) },
    );

    runOuter();

    expect(records).toHaveLength(2);
    expect(recordFor(records, "request.inner_root")).toMatchObject({
      marker: "inner",
      activity: { entries: [{ label: "inner" }] },
    });
    expect(recordFor(records, "request.outer_root")).toMatchObject({
      marker: "outer",
      activity: {
        entries: [{ label: "outer:before" }, { label: "outer:after" }],
      },
    });
    expect(
      JSON.stringify(recordFor(records, "request.outer_root")),
    ).not.toContain('"label":"inner"');
  });

  it("treats same-root handle reentry as transparent and skips inner projectors", () => {
    const { EntryPlugin: ActivityPlugin } = createInstantPlugin({
      eventId: "activity.reentry_entry",
      pluginId: "activity-reentry-entry",
    });
    const Root = createRoot("request.same_root_reentry", {
      activity: ActivityPlugin.events,
    });
    const records = collectRecords();
    const calls = {
      application: 0,
      outerInput: 0,
      outerResult: 0,
      innerInput: 0,
      innerResult: 0,
    };
    const applicationResult = { ok: true };
    const inner = Root.handle(
      () => {
        calls.application += 1;
        ActivityPlugin("inside-reentry");
        return applicationResult;
      },
      {
        input: () => {
          calls.innerInput += 1;
          return { marker: "inner" };
        },
        result: () => {
          calls.innerResult += 1;
          return { marker: "inner-result" };
        },
      },
    );
    const outer = Root.handle(() => inner(), {
      input: () => {
        calls.outerInput += 1;
        return { marker: "outer" };
      },
      result: () => {
        calls.outerResult += 1;
        return { marker: "outer-result" };
      },
    });

    expect(outer()).toBe(applicationResult);

    expect(calls).toEqual({
      application: 1,
      outerInput: 1,
      outerResult: 1,
      innerInput: 0,
      innerResult: 0,
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      "@event": "request.same_root_reentry",
      marker: "outer-result",
      activity: { entries: [{ label: "inside-reentry" }] },
    });
  });
});
