import { describe, expect, it } from "vitest";
import { event, init, type Schema, type SinkRecord } from "../src/index.js";
import { plugin } from "../src/plugin.js";

type JsonObject = Record<string, unknown>;

const objectSchema = <Fields extends JsonObject = JsonObject>(): Schema<
  Fields,
  Fields
> => ({
  "~standard": {
    version: 1,
    vendor: "event-definition-contract-test",
    validate(value: unknown) {
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        return { value: value as Fields };
      }
      return { issues: [{ message: "Expected an object" }] };
    },
  },
});

type EventOptions = Parameters<typeof event>[0];

const constructUnsafe = (overrides: Record<string, unknown>) =>
  event({
    id: "contract.root",
    version: 1,
    schema: objectSchema(),
    ...overrides,
  } as EventOptions);

const makeLeaf = (id = "contract.leaf") =>
  event({
    id,
    version: 1,
    schema: objectSchema(),
    timing: "instant",
  });

describe("Event definition identity", () => {
  it("creates a fresh opaque identity for each exact definition value", () => {
    const first = makeLeaf("contract.same_shape");
    const second = makeLeaf("contract.same_shape");

    expect(first).not.toBe(second);
    expect(() =>
      event({
        id: "contract.distinct_identities",
        version: 1,
        schema: objectSchema(),
        tree: { first, second },
      }),
    ).not.toThrow();
  });

  it("attaches by the exact mounted definition value, never by semantic id", () => {
    const exactDefinition = event({
      id: "contract.same_semantic_id",
      version: 1,
      schema: objectSchema<{ value: string }>(),
    });
    const lookalikeDefinition = event({
      id: "contract.same_semantic_id",
      version: 1,
      schema: objectSchema<{ value: string }>(),
    });

    const ExactPlugin = plugin({
      id: "contract-exact-definition",
      events: { occurrence: exactDefinition },
      instrument({ events, observe }) {
        return <F extends (value: string) => string>(fn: F): F =>
          observe(events.occurrence, fn, {
            input: ({ args: [value] }) => ({ value }),
          });
      },
    });
    const LookalikePlugin = plugin({
      id: "contract-lookalike-definition",
      events: { occurrence: lookalikeDefinition },
      instrument({ events, observe }) {
        return <F extends (value: string) => string>(fn: F): F =>
          observe(events.occurrence, fn, {
            input: ({ args: [value] }) => ({ value }),
          });
      },
    });
    const Root = event({
      id: "contract.identity_root",
      version: 1,
      schema: objectSchema(),
      tree: { mounted: ExactPlugin.events },
    });
    const delivered: SinkRecord[] = [];
    init({
      service: "event-definition-contract",
      env: "test",
      sinks: [(record) => delivered.push(record)],
    });

    const exact = ExactPlugin((value) => value);
    const lookalike = LookalikePlugin((value) => value);
    const run = Root.handle(() => {
      lookalike("must-not-attach");
      exact("exact-definition");
    });

    run();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      mounted: {
        occurrence: {
          value: "exact-definition",
        },
      },
    });
    expect(JSON.stringify(delivered[0])).not.toContain("must-not-attach");
  });
});

describe("Event definition immutability", () => {
  it("snapshots and deeply freezes the definition and every nested tree group", () => {
    const leaf = makeLeaf();
    const callerTree = {
      provider: {
        activity: leaf,
      },
    };
    const definition = event({
      id: "contract.frozen",
      version: 1,
      schema: objectSchema(),
      tree: callerTree,
    });

    expect(Object.isFrozen(definition)).toBe(true);
    expect(definition.tree).not.toBe(callerTree);
    expect(Object.isFrozen(definition.tree)).toBe(true);
    expect(definition.tree.provider).not.toBe(callerTree.provider);
    expect(Object.isFrozen(definition.tree.provider)).toBe(true);
    expect(Object.isFrozen(definition.tree.provider.activity)).toBe(true);

    const replacement = makeLeaf("contract.replacement");
    callerTree.provider.activity = replacement;

    expect(definition.tree.provider.activity).toBe(leaf);
  });
});

describe("Event definition scalar validation", () => {
  it.each(["", "   ", "\n\t"])("rejects a blank semantic id %j", (id) => {
    expect(() => constructUnsafe({ id })).toThrow(/event id/i);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid version %s",
    (version) => {
      expect(() => constructUnsafe({ version })).toThrow(
        /version.*positive integer/i,
      );
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid repeated cardinality max %s",
    (max) => {
      expect(() => constructUnsafe({ cardinality: { many: { max } } })).toThrow(
        /(?:cardinality|max).*positive integer/i,
      );
    },
  );
});

describe("Event tree validation", () => {
  it.each([
    ["the root tree", (leaf: ReturnType<typeof makeLeaf>) => [leaf]],
    [
      "a nested tree group",
      (leaf: ReturnType<typeof makeLeaf>) => ({ nested: [leaf] }),
    ],
  ])("rejects an array used as %s", (_label, makeTree) => {
    expect(() => constructUnsafe({ tree: makeTree(makeLeaf()) })).toThrow(
      /event tree|plain object|array/i,
    );
  });

  it("rejects accessors without invoking them", () => {
    let getterCalls = 0;
    const tree: Record<string, unknown> = {};
    Object.defineProperty(tree, "activity", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return makeLeaf();
      },
    });

    let constructionError: unknown;
    try {
      constructUnsafe({ tree });
    } catch (error) {
      constructionError = error;
    }

    expect.soft(getterCalls).toBe(0);
    expect(constructionError).toBeInstanceOf(Error);
    expect((constructionError as Error).message).toMatch(/accessor/i);
  });

  it("safely rejects cyclic trees", () => {
    const tree: Record<string, unknown> = {};
    tree.self = tree;

    expect(() => constructUnsafe({ tree })).toThrow(/cycl(?:e|ic)/i);
  });

  it("rejects enumerable symbol keys", () => {
    const tree: Record<PropertyKey, unknown> = { activity: makeLeaf() };
    tree[Symbol("hidden")] = makeLeaf("contract.symbol");

    expect(() => constructUnsafe({ tree })).toThrow(/symbol/i);
  });

  it.each(["__proto__", "prototype", "constructor"])(
    "rejects prototype-pollution tree key %s",
    (key) => {
      const tree: Record<string, unknown> = {};
      Object.defineProperty(tree, key, {
        value: makeLeaf("contract.prototype_key"),
        enumerable: true,
        configurable: true,
        writable: true,
      });

      expect(() => constructUnsafe({ tree })).toThrow(
        /event tree key|prototype|constructor|unsafe|reserved/i,
      );
    },
  );

  it.each([
    "@event",
    "@event_version",
    "service",
    "env",
    "timestamp",
    "duration_ms",
    "success",
    "error",
    "@amplio",
  ])("rejects runtime-reserved tree key %s", (key) => {
    const tree = { [key]: makeLeaf("contract.reserved_key") };

    expect(() => constructUnsafe({ tree })).toThrow(
      /event tree key|reserved|runtime-owned/i,
    );
  });

  it("rejects mounting the same exact Event definition at two paths", () => {
    const leaf = makeLeaf("contract.duplicate");

    expect(() =>
      event({
        id: "contract.duplicate_root",
        version: 1,
        schema: objectSchema(),
        tree: {
          first: leaf,
          nested: { second: leaf },
        },
      }),
    ).toThrow(/mounted more than once|duplicate/i);
  });
});

describe("Event schema construction contract", () => {
  it.each([
    ["null", null],
    ["an array", []],
    ["an empty object", {}],
    ["a null Standard Schema descriptor", { "~standard": null }],
    [
      "a non-callable validator",
      {
        "~standard": {
          version: 1,
          vendor: "invalid",
          validate: 42,
        },
      },
    ],
  ])("rejects %s as a non-object-shaped schema contract", (_label, schema) => {
    expect(() => constructUnsafe({ schema })).toThrow(/schema/i);
  });
});
