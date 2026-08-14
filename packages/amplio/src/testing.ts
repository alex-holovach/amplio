import {
  getDeliveredRecordDefinition,
  isEventDefinition,
  type EventDefinition,
  type EventRecord,
  type EventTree,
  type SinkRecord,
} from "./event.js";
import type { RuntimeDiagnostic, Sink } from "./semantic-types.js";

const TEST_DIAGNOSTIC_HANDLER = Symbol.for(
  "amplio.testing-diagnostic-handler.v2",
);

export interface TestDiagnostic {
  readonly code: string;
  readonly event?: string;
  readonly stage?: string;
  readonly path?: readonly (string | number)[];
  readonly count?: number;
}

export type TestSink = Sink & {
  all<E extends EventDefinition>(definition: E): readonly EventRecord<E>[];
  single<E extends EventDefinition>(definition: E): EventRecord<E>;
  clear(): void;
  readonly diagnostics: readonly TestDiagnostic[];
  assertNoDiagnostics(): void;
};

const diagnosticsFrom = (record: SinkRecord): TestDiagnostic[] => {
  const metadata = record["@amplio"];
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    return [];
  }
  const value = metadata as Record<string, unknown>;
  return Array.isArray(value.diagnostics)
    ? value.diagnostics.filter(
        (detail): detail is TestDiagnostic =>
          detail !== null &&
          typeof detail === "object" &&
          typeof (detail as { code?: unknown }).code === "string" &&
          typeof (detail as { event?: unknown }).event === "string",
      )
    : [];
};

export function createTestSink(): TestSink {
  const records: SinkRecord[] = [];
  const runtimeDiagnostics: TestDiagnostic[] = [];
  const sink = ((record: SinkRecord) => {
    records.push(record);
  }) as TestSink;

  Object.defineProperty(sink, TEST_DIAGNOSTIC_HANDLER, {
    enumerable: false,
    configurable: false,
    value: (diagnostic: RuntimeDiagnostic): void => {
      runtimeDiagnostics.push({ ...diagnostic });
    },
  });

  sink.all = <E extends EventDefinition>(
    definition: E,
  ): readonly EventRecord<E>[] =>
    records.filter(
      (record) => getDeliveredRecordDefinition(record) === definition,
    ) as EventRecord<E>[];
  sink.single = <E extends EventDefinition>(definition: E): EventRecord<E> => {
    const matching = sink.all(definition);
    if (matching.length !== 1) {
      throw new Error(
        `Expected exactly one "${definition.id}" Event, received ${matching.length}`,
      );
    }
    return matching[0]!;
  };
  sink.clear = (): void => {
    records.length = 0;
    runtimeDiagnostics.length = 0;
  };
  Object.defineProperty(sink, "diagnostics", {
    enumerable: true,
    configurable: false,
    get: () => [...runtimeDiagnostics, ...records.flatMap(diagnosticsFrom)],
  });
  sink.assertNoDiagnostics = (): void => {
    if (sink.diagnostics.length > 0) {
      const summary = sink.diagnostics
        .map(
          (diagnostic) =>
            `${diagnostic.code}:${diagnostic.event ?? "unknown-event"}`,
        )
        .join(", ");
      throw new Error(
        `Expected no Amplio diagnostics, received ${sink.diagnostics.length}: ${summary}`,
      );
    }
  };
  return sink;
}

const runtimeKeys = new Set([
  "@event",
  "@event_version",
  "service",
  "env",
  "timestamp",
  "duration_ms",
  "success",
  "error",
  "@amplio",
  "resource",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const sameValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => sameValue(entry, right[index]))
    );
  }
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => key in right && sameValue(left[key], right[key]))
  );
};

const assertStructuredError = (value: unknown, path: string): void => {
  if (value === undefined) return;
  if (!isObject(value) || typeof value.type !== "string") {
    throw new TypeError(`${path}.error must contain a string type`);
  }
  for (const key of Object.keys(value)) {
    if (key !== "type" && key !== "code" && key !== "message") {
      throw new TypeError(`${path}.error contains unsupported field ${key}`);
    }
    if (key !== "type" && typeof value[key] !== "string") {
      throw new TypeError(`${path}.error.${key} must be a string`);
    }
  }
};

const assertSchemaOutput = (
  definition: EventDefinition,
  node: Record<string, unknown>,
  path: string,
): void => {
  const treeKeys = new Set(Object.keys(definition.tree));
  const own = Object.fromEntries(
    Object.entries(node).filter(
      ([key]) => !runtimeKeys.has(key) && !treeKeys.has(key),
    ),
  );
  try {
    const validated = definition.schema["~standard"].validate(own);
    let then: unknown;
    try {
      then =
        validated !== null &&
        (typeof validated === "object" || typeof validated === "function")
          ? (validated as { readonly then?: unknown }).then
          : undefined;
    } catch {
      throw new TypeError(`${path} schema result could not be inspected`);
    }
    if (typeof then === "function") {
      void Promise.resolve(validated).catch(() => undefined);
      throw new TypeError(`${path} uses an unsupported asynchronous schema`);
    }
    if ("issues" in validated && validated.issues) {
      const details = validated.issues
        .map((issue) => {
          const issuePath = issue.path
            ?.map((part) =>
              typeof part === "object" && part !== null && "key" in part
                ? String(part.key)
                : String(part),
            )
            .join(".");
          return issuePath ? `${issuePath}: ${issue.message}` : issue.message;
        })
        .join(", ");
      throw new TypeError(`${path} is invalid against its schema: ${details}`);
    }
    if (!("value" in validated) || !sameValue(validated.value, own)) {
      throw new TypeError(
        `${path} schema transforms cannot validate an unbranded external Event record`,
      );
    }
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`${path} schema validation failed`);
  }
};

const assertTree = (
  tree: EventTree,
  node: Record<string, unknown>,
  trusted: boolean,
  path: string,
): void => {
  for (const [key, mounted] of Object.entries(tree)) {
    const value = node[key];
    if (value === undefined) continue;
    const childPath = `${path}.${key}`;
    if (isEventDefinition(mounted)) {
      const assertOccurrence = (
        occurrence: unknown,
        occurrencePath: string,
      ) => {
        if (!isObject(occurrence)) {
          throw new TypeError(`${occurrencePath} must be an Event object`);
        }
        if (mounted.timing === "duration") {
          if (
            typeof occurrence.duration_ms !== "number" ||
            !Number.isFinite(occurrence.duration_ms) ||
            typeof occurrence.success !== "boolean"
          ) {
            throw new TypeError(
              `${occurrencePath} has an invalid duration Event envelope`,
            );
          }
          assertStructuredError(occurrence.error, occurrencePath);
        }
        if (!trusted) assertSchemaOutput(mounted, occurrence, occurrencePath);
        assertTree(mounted.tree, occurrence, trusted, occurrencePath);
      };
      if (mounted.cardinality === "single") {
        assertOccurrence(value, childPath);
      } else {
        if (
          !Array.isArray(value) ||
          value.length > mounted.cardinality.many.max
        ) {
          throw new TypeError(`${childPath} has invalid repeated cardinality`);
        }
        value.forEach((entry, index) =>
          assertOccurrence(entry, `${childPath}.${index}`),
        );
      }
      continue;
    }
    if (!isObject(value)) {
      throw new TypeError(`${childPath} must be an Event tree object`);
    }
    if (Object.keys(value).some((childKey) => !(childKey in mounted))) {
      throw new TypeError(`${childPath} contains an undeclared Event branch`);
    }
    assertTree(mounted, value, trusted, childPath);
  }
};

export function assertEvent<E extends EventDefinition>(
  definition: E,
  record: unknown,
): asserts record is EventRecord<E> {
  if (!isObject(record)) {
    throw new TypeError(`Expected a "${definition.id}" Event record`);
  }
  const actualDefinition = getDeliveredRecordDefinition(record);
  if (actualDefinition && actualDefinition !== definition) {
    throw new TypeError(
      `Expected Event definition "${definition.id}", received a different definition`,
    );
  }
  if (
    record["@event"] !== definition.id ||
    record["@event_version"] !== definition.version
  ) {
    throw new TypeError(
      `Expected Event "${definition.id}" version ${definition.version}, received "${String(record["@event"])}" version ${String(record["@event_version"])}`,
    );
  }
  if (
    typeof record.service !== "string" ||
    typeof record.env !== "string" ||
    typeof record.timestamp !== "string" ||
    typeof record.duration_ms !== "number" ||
    !Number.isFinite(record.duration_ms) ||
    typeof record.success !== "boolean"
  ) {
    throw new TypeError(
      `Event "${definition.id}" has an invalid runtime envelope`,
    );
  }
  assertStructuredError(record.error, `Event "${definition.id}"`);
  const trusted = actualDefinition === definition;
  if (!trusted)
    assertSchemaOutput(definition, record, `Event "${definition.id}"`);
  assertTree(definition.tree, record, trusted, `Event "${definition.id}"`);
}
