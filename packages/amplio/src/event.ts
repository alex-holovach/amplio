import { AsyncLocalStorage } from "node:async_hooks";
import { types as nodeTypes } from "node:util";
import { cloneRuntimeConfig, resolveRuntimeConfig } from "./runtime-config.js";
import { deepMerge } from "./deep-merge.js";
import { isDiagnosticContext, reportRuntimeDiagnostic } from "./diagnostics.js";
import { redactRecord } from "./redact.js";
import { shouldSample } from "./sampling.js";
import {
  releaseSinkGeneration,
  retainSinkGeneration,
  runSinksSync,
} from "./sinks.js";
import type {
  AmplioConfig,
  DeepPartial,
  LogRecord,
  ResourceAttributes,
  RuntimeDiagnostic,
  SinkRecord,
} from "./semantic-types.js";

type AnyFunction = (...args: any[]) => any;
type NativePromiseResult<Result> =
  Result extends Promise<infer Value> ? Value : Result;
type SettledResult<F extends AnyFunction> = NativePromiseResult<ReturnType<F>>;
const nativePromiseThen = Promise.prototype.then;

const attachNativePromiseSettlement = (
  value: Promise<unknown>,
  fulfilled: (value: unknown) => void,
  rejected: (error: unknown) => void,
): boolean => {
  try {
    void Reflect.apply(nativePromiseThen, value, [fulfilled, rejected]);
    return true;
  } catch {
    return false;
  }
};

const EventIdentity: unique symbol = Symbol("AmplioEventIdentity");
const EVENT_DEFINITIONS_KEY = Symbol.for("amplio.event-definitions.v2");
type GlobalWithEventDefinitions = typeof globalThis & {
  [EVENT_DEFINITIONS_KEY]?: WeakSet<object>;
};
const globalWithEventDefinitions = globalThis as GlobalWithEventDefinitions;
const eventDefinitions =
  globalWithEventDefinitions[EVENT_DEFINITIONS_KEY] ?? new WeakSet<object>();
globalWithEventDefinitions[EVENT_DEFINITIONS_KEY] = eventDefinitions;

export interface SchemaIssue {
  readonly message: string;
  readonly path?:
    readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}

export interface StructuredError {
  readonly type: string;
  readonly code?: string;
  readonly message?: string;
}

export type SchemaResult<Output extends Record<string, unknown>> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly SchemaIssue[] };

export interface Schema<
  Input extends Record<string, unknown> = Record<string, unknown>,
  Output extends Record<string, unknown> = Input,
> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly types?:
      { readonly input: Input; readonly output: Output } | undefined;
    validate(
      value: unknown,
    ): SchemaResult<Output> | PromiseLike<SchemaResult<Output>>;
  };
}

type SchemaInput<S> = S extends Schema<infer Input, any> ? Input : never;
type SchemaOutput<S> = S extends Schema<any, infer Output> ? Output : never;

export interface EventProjectors<
  F extends AnyFunction,
  Input extends Record<string, unknown>,
> {
  input?: (context: { args: Parameters<F> }) => DeepPartial<Input> | undefined;
  result?: (context: {
    args: Parameters<F>;
    result: SettledResult<F>;
  }) => DeepPartial<Input> | undefined;
  success?: (context: {
    args: Parameters<F>;
    result: SettledResult<F>;
  }) => boolean;
  error?: (context: {
    args: Parameters<F>;
    error: unknown;
  }) => DeepPartial<Input> | undefined;
}

export interface ObservationHandle<Node extends Record<string, unknown>> {
  run<T>(fn: () => T): T;
  bind<F extends AnyFunction>(fn: F): F;
  update(value: DeepPartial<Node>): void;
  end(value?: DeepPartial<Node>, options?: { success?: boolean }): void;
  fail(error: unknown, value?: DeepPartial<Node>): void;
  cancel(reasonCode?: string): void;
}

export interface EventScope<
  E extends EventDefinition & { readonly timing: "duration" },
> {
  run<T>(fn: () => T): T;
  bind<F extends AnyFunction>(fn: F): F;
  update(value: DeepPartial<EventInput<E>>): void;
  finish(
    value?: DeepPartial<EventInput<E>>,
    options?: { success?: boolean },
  ): void;
  fail(error: unknown, value?: DeepPartial<EventInput<E>>): void;
  cancel(reasonCode?: string): void;
}

export type EventTiming = "instant" | "duration";
export type EventCardinality = "single" | { many: { max: number } };
export type EventTree = {
  readonly [key: string]: EventDefinition | EventTree;
};

interface EventDefinitionFields<
  Id extends string = string,
  Version extends number = number,
  S extends Schema = Schema,
  Timing extends EventTiming = EventTiming,
  Cardinality extends EventCardinality = EventCardinality,
  Tree extends EventTree = EventTree,
> {
  readonly [EventIdentity]: {
    readonly input: SchemaInput<S>;
    readonly output: SchemaOutput<S>;
    readonly timing: Timing;
    readonly cardinality: Cardinality;
    readonly tree: Tree;
  };
  readonly id: Id;
  readonly version: Version;
  readonly schema: S;
  readonly timing: Timing;
  readonly cardinality: Cardinality;
  readonly maxDurationMs: number;
  readonly tree: Tree;
}

export type EventDefinition<
  Id extends string = string,
  Version extends number = number,
  S extends Schema = Schema,
  Timing extends EventTiming = EventTiming,
  Cardinality extends EventCardinality = EventCardinality,
  Tree extends EventTree = EventTree,
> = Readonly<EventDefinitionFields<Id, Version, S, Timing, Cardinality, Tree>> &
  (Timing extends "duration"
    ? {
        handle<F extends AnyFunction>(
          fn: F,
          projectors?: EventProjectors<F, SchemaInput<S>>,
        ): F;
      }
    : {});

export type Event = EventDefinition;
export type EventInput<E extends EventDefinition> = SchemaInput<E["schema"]>;
export type EventOutput<E extends EventDefinition> = SchemaOutput<E["schema"]>;

type JsonSafe<Value> = Value extends string | number | boolean | null
  ? Value
  : Value extends Date | ((...args: any[]) => unknown) | undefined
    ? never
    : Value extends readonly (infer Item)[]
      ? undefined extends Item
        ? never
        : readonly JsonSafe<Item>[]
      : Value extends object
        ? {
            [Key in keyof Value]: {} extends Pick<Value, Key>
              ? JsonSafe<Exclude<Value[Key], undefined>> | undefined
              : undefined extends Value[Key]
                ? never
                : JsonSafe<Value[Key]>;
          }
        : never;

type JsonSchemaContract<S extends Schema> =
  SchemaInput<S> extends JsonSafe<SchemaInput<S>>
    ? SchemaOutput<S> extends JsonSafe<SchemaOutput<S>>
      ? unknown
      : { readonly "Event schema output must be JSON-safe": never }
    : { readonly "Event schema input must be JSON-safe": never };

export type EventFromTree<Tree extends EventTree> = {
  [Key in keyof Tree]: Tree[Key] extends EventDefinition
    ? Tree[Key]
    : Tree[Key] extends EventTree
      ? EventFromTree<Tree[Key]>
      : never;
}[keyof Tree];

export type { SinkRecord } from "./semantic-types.js";

type DurationEventFields<E extends EventDefinition> =
  E["timing"] extends "duration"
    ? {
        readonly duration_ms: number;
        readonly success: boolean;
        readonly error?: StructuredError;
      }
    : {};

type RuntimeEventKey =
  | "@event"
  | "@event_version"
  | "service"
  | "env"
  | "timestamp"
  | "duration_ms"
  | "success"
  | "error"
  | "@amplio"
  | "resource";

type DeepReadonly<Value> = Value extends
  | string
  | number
  | boolean
  | null
  | undefined
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

type SemanticEventOutput<E extends EventDefinition> = DeepReadonly<
  Omit<EventOutput<E>, RuntimeEventKey | keyof E["tree"]>
>;

export type EventNodeRecord<E extends EventDefinition> = DeepReadonly<
  SemanticEventOutput<E> & EventTreeRecord<E["tree"]> & DurationEventFields<E>
>;

type MountedEventRecord<E extends EventDefinition> = E["cardinality"] extends {
  readonly many: { readonly max: number };
}
  ? readonly EventNodeRecord<E>[]
  : EventNodeRecord<E>;

/**
 * Sparse serialized shape of a mounted Event tree. Every branch is optional:
 * defining an Event says where an observation may appear, not that application
 * work must manufacture one.
 */
export type EventTreeRecord<Tree extends EventTree> = Readonly<{
  [Key in keyof Tree]?: Tree[Key] extends EventDefinition
    ? MountedEventRecord<Tree[Key]>
    : Tree[Key] extends EventTree
      ? EventTreeRecord<Tree[Key]>
      : never;
}>;

export type EventRecord<E extends EventDefinition> = DeepReadonly<
  SemanticEventOutput<E> &
    EventTreeRecord<E["tree"]> & {
      "@event": E["id"];
      "@event_version": E["version"];
      service: string;
      env: string;
      timestamp: string;
      duration_ms: number;
      success: boolean;
      error?: StructuredError;
    }
>;

const runtimeOwnedKeys = new Set([
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

const forbiddenTreeKeys = new Set([
  ...runtimeOwnedKeys,
  "__proto__",
  "prototype",
  "constructor",
]);
const eventIdPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const treeKeyPattern = /^[a-z][a-z0-9_]*$/;
const DEFAULT_MAX_DURATION_MS = 300_000;

const normalizeEventTree = (
  input: unknown,
  ancestors = new Set<object>(),
): EventTree => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("event tree must be a plain object");
  }

  let prototype: object | null;
  let keys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(input) as object | null;
    keys = Reflect.ownKeys(input);
  } catch {
    throw new Error("event tree could not be inspected safely");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("event tree must contain only plain objects");
  }
  if (ancestors.has(input)) {
    throw new Error("event tree must be acyclic");
  }
  ancestors.add(input);

  const result = Object.create(null) as Record<
    string,
    EventDefinition | EventTree
  >;
  for (const key of keys) {
    if (typeof key === "symbol") {
      throw new Error("event tree cannot contain symbol keys");
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, key);
    } catch {
      throw new Error("event tree property could not be inspected safely");
    }
    if (!descriptor) continue;
    if (descriptor.get || descriptor.set) {
      throw new Error(`event tree key "${key}" cannot be an accessor`);
    }
    if (!descriptor.enumerable) continue;
    if (!treeKeyPattern.test(key) || forbiddenTreeKeys.has(key)) {
      throw new Error(`invalid event tree key "${key}"`);
    }
    const value = descriptor.value as unknown;
    result[key] = isEventDefinition(value)
      ? value
      : normalizeEventTree(value, ancestors);
  }
  ancestors.delete(input);
  return Object.freeze(result) as EventTree;
};

/** @internal Shared with the Plugin authoring entrypoint. */
export const snapshotEventTree = normalizeEventTree;

const assertSchema: (schema: unknown) => asserts schema is Schema = (
  schema,
) => {
  if (schema === null || typeof schema !== "object") {
    throw new Error("event schema must implement Standard Schema v1");
  }
  let standard: unknown;
  try {
    standard = (schema as { readonly "~standard"?: unknown })["~standard"];
  } catch {
    throw new Error("event schema could not be inspected safely");
  }
  if (
    standard === null ||
    typeof standard !== "object" ||
    (standard as { version?: unknown }).version !== 1 ||
    typeof (standard as { validate?: unknown }).validate !== "function"
  ) {
    throw new Error("event schema must implement Standard Schema v1");
  }
};

interface EventTarget {
  readonly path: readonly string[];
  readonly definition: EventDefinition;
}

interface EventFrame {
  readonly definition: EventDefinition;
  readonly rootDefinition: EventDefinition;
  readonly targets: ReadonlyMap<EventDefinition, EventTarget>;
  readonly ownKeys: ReadonlySet<string>;
  readonly shadow: boolean;
  readonly config: AmplioConfig;
  readonly ownsGeneration: boolean;
  own: Record<string, unknown>;
  readonly children: Record<string, unknown>;
  readonly seen: Map<EventDefinition, number>;
  readonly pending: Set<EventAttachment>;
  readonly truncations: Map<
    string,
    { path: SemanticPath; max: number; dropped: number }
  >;
  readonly incompletes: Map<
    string,
    { path: SemanticPath; event: string; pending: number }
  >;
  readonly diagnostics: Map<
    string,
    { code: string; path: SemanticPath; event: string; count: number }
  >;
  instrumentationFailed: boolean;
  closed: boolean;
  readonly startedAt: number;
}

type SemanticPath = Array<string | number>;

interface EventAttachment {
  readonly parent: EventFrame;
  readonly target: EventTarget;
  readonly accepted: boolean;
  readonly index?: number;
  settled: boolean;
}

interface DefinitionMetadata {
  readonly targets: ReadonlyMap<EventDefinition, EventTarget>;
  readonly ownKeys: ReadonlySet<string>;
}

const EVENT_METADATA_KEY = Symbol.for("amplio.event-metadata.v2");
const DELIVERED_DEFINITIONS_KEY = Symbol.for("amplio.delivered-definitions.v2");
type GlobalWithEventMetadata = typeof globalThis & {
  [EVENT_METADATA_KEY]?: WeakMap<EventDefinition, DefinitionMetadata>;
  [DELIVERED_DEFINITIONS_KEY]?: WeakMap<object, EventDefinition>;
};
const globalWithEventMetadata = globalThis as GlobalWithEventMetadata;
const definitionMetadata =
  globalWithEventMetadata[EVENT_METADATA_KEY] ??
  new WeakMap<EventDefinition, DefinitionMetadata>();
const deliveredRecordDefinitions =
  globalWithEventMetadata[DELIVERED_DEFINITIONS_KEY] ??
  new WeakMap<object, EventDefinition>();
globalWithEventMetadata[EVENT_METADATA_KEY] = definitionMetadata;
globalWithEventMetadata[DELIVERED_DEFINITIONS_KEY] = deliveredRecordDefinitions;

/** @internal Used by the definition-aware testing entrypoint. */
export const getDeliveredRecordDefinition = (
  record: object,
): EventDefinition | undefined => deliveredRecordDefinitions.get(record);

const EVENT_STORAGE_KEY = Symbol.for("amplio.event-storage.v2");
type GlobalWithEventStorage = typeof globalThis & {
  [EVENT_STORAGE_KEY]?: AsyncLocalStorage<EventFrame>;
};
const globalWithEventStorage = globalThis as GlobalWithEventStorage;
const eventStorage =
  globalWithEventStorage[EVENT_STORAGE_KEY] ??
  new AsyncLocalStorage<EventFrame>();
globalWithEventStorage[EVENT_STORAGE_KEY] = eventStorage;

const reportDiagnostic = (
  config: AmplioConfig,
  diagnostic: RuntimeDiagnostic,
): void => {
  eventStorage.exit(() =>
    reportRuntimeDiagnostic(config.eventRuntime?.onDiagnostic, diagnostic),
  );
};

export const isEventDefinition = (value: unknown): value is EventDefinition =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  eventDefinitions.has(value);

const compileTargets = (
  tree: EventTree,
  path: readonly string[] = [],
  targets = new Map<EventDefinition, EventTarget>(),
): ReadonlyMap<EventDefinition, EventTarget> => {
  for (const [key, value] of Object.entries(tree)) {
    const nextPath = [...path, key];
    if (isEventDefinition(value)) {
      if (targets.has(value)) {
        throw new Error(`event "${value.id}" is mounted more than once`);
      }
      targets.set(value, { path: nextPath, definition: value });
    } else {
      compileTargets(value, nextPath, targets);
    }
  }
  return targets;
};

const setAtPath = (
  root: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void => {
  let cursor = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]!;
    const existing = cursor[key];
    if (isObject(existing)) {
      cursor = existing;
    } else {
      const next: Record<string, unknown> = {};
      cursor[key] = next;
      cursor = next;
    }
  }
  cursor[path.at(-1)!] = value;
};

const appendAtPath = (
  root: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void => {
  let cursor = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]!;
    const existing = cursor[key];
    if (isObject(existing)) {
      cursor = existing;
    } else {
      const next: Record<string, unknown> = {};
      cursor[key] = next;
      cursor = next;
    }
  }
  const key = path.at(-1)!;
  const values = Array.isArray(cursor[key]) ? (cursor[key] as unknown[]) : [];
  values.push(value);
  cursor[key] = values;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const getAtPath = (
  root: Record<string, unknown>,
  path: readonly string[],
): unknown => {
  let cursor: unknown = root;
  for (const key of path) {
    if (!isObject(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
};

const snapshotConfiguration = (): AmplioConfig =>
  cloneRuntimeConfig(resolveRuntimeConfig());

const deleteAtPath = (
  root: Record<string, unknown>,
  path: readonly string[],
): void => {
  const parents: Array<{ object: Record<string, unknown>; key: string }> = [];
  let cursor = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]!;
    const next = cursor[key];
    if (!isObject(next)) return;
    parents.push({ object: cursor, key });
    cursor = next;
  }
  delete cursor[path.at(-1)!];
  for (let index = parents.length - 1; index >= 0; index -= 1) {
    const { object, key } = parents[index]!;
    const child = object[key];
    if (isObject(child) && Object.keys(child).length === 0) delete object[key];
  }
};

const makeFrame = (
  definition: EventDefinition,
  rootDefinition: EventDefinition = definition,
  shadow = false,
  inheritedConfig?: AmplioConfig,
): EventFrame => {
  const metadata = definitionMetadata.get(definition);
  if (!metadata) {
    throw new Error(`event "${definition.id}" has no runtime metadata`);
  }
  const config = inheritedConfig ?? snapshotConfiguration();
  const ownsGeneration = inheritedConfig === undefined;
  if (ownsGeneration) retainSinkGeneration(config);
  return {
    definition,
    rootDefinition,
    targets: metadata.targets,
    ownKeys: metadata.ownKeys,
    shadow,
    config,
    ownsGeneration,
    own: {},
    children: {},
    seen: new Map(),
    pending: new Set(),
    truncations: new Map(),
    incompletes: new Map(),
    diagnostics: new Map(),
    instrumentationFailed: false,
    closed: false,
    startedAt: Date.now(),
  };
};

const attachmentPath = (attachment: EventAttachment): SemanticPath =>
  attachment.index === undefined
    ? [...attachment.target.path]
    : [...attachment.target.path, attachment.index];

const addDiagnostic = (
  frame: EventFrame,
  code: string,
  path: SemanticPath,
  definition: EventDefinition,
): void => {
  const key = `${code}:${JSON.stringify(path)}:${definition.id}`;
  const existing = frame.diagnostics.get(key);
  frame.diagnostics.set(key, {
    code,
    path: [...path],
    event: definition.id,
    count: (existing?.count ?? 0) + 1,
  });
};

const reserveAttachment = (
  parent: EventFrame,
  target: EventTarget,
): EventAttachment => {
  if (parent.closed || parent.shadow) {
    return { parent, target, accepted: false, settled: false };
  }
  const count = parent.seen.get(target.definition) ?? 0;
  parent.seen.set(target.definition, count + 1);

  if (target.definition.cardinality === "single") {
    if (count > 0) {
      if (count === 1) {
        addDiagnostic(
          parent,
          "duplicate_single",
          [...target.path],
          target.definition,
        );
      }
      return { parent, target, accepted: false, settled: false };
    }
    const attachment: EventAttachment = {
      parent,
      target,
      accepted: true,
      settled: false,
    };
    parent.pending.add(attachment);
    return attachment;
  }

  const existing = getAtPath(parent.children, target.path);
  const values = Array.isArray(existing) ? existing : [];
  const max = target.definition.cardinality.many.max;
  if (values.length >= max) {
    const key = JSON.stringify(target.path);
    const current = parent.truncations.get(key);
    parent.truncations.set(key, {
      path: [...target.path],
      max,
      dropped: (current?.dropped ?? 0) + 1,
    });
    return { parent, target, accepted: false, settled: false };
  }

  const index = values.length;
  values.push(undefined);
  setAtPath(parent.children, target.path, values);
  const attachment: EventAttachment = {
    parent,
    target,
    accepted: true,
    index,
    settled: false,
  };
  parent.pending.add(attachment);
  return attachment;
};

const closeFrame = (frame: EventFrame): void => {
  if (frame.closed) return;
  frame.closed = true;
  if (frame.ownsGeneration) releaseSinkGeneration(frame.config);
  for (const attachment of frame.pending) {
    const path = attachmentPath(attachment);
    const key = JSON.stringify(path);
    const current = frame.incompletes.get(key);
    frame.incompletes.set(key, {
      path,
      event: attachment.target.definition.id,
      pending: (current?.pending ?? 0) + 1,
    });
  }
  frame.pending.clear();

  for (const target of frame.targets.values()) {
    if (target.definition.cardinality === "single") continue;
    const existing = getAtPath(frame.children, target.path);
    if (Array.isArray(existing)) {
      const settled = existing.filter((entry) => entry !== undefined);
      if (settled.length === 0) {
        deleteAtPath(frame.children, target.path);
      } else {
        setAtPath(frame.children, target.path, settled);
      }
    }
  }
};

const operationalMetadata = (
  frame: EventFrame,
): Record<string, unknown> | undefined => {
  const diagnostics = [...frame.diagnostics.values()];
  const incomplete = [...frame.incompletes.values()];
  const truncated = [...frame.truncations.values()];
  if (
    diagnostics.length === 0 &&
    incomplete.length === 0 &&
    truncated.length === 0 &&
    !frame.instrumentationFailed
  ) {
    return undefined;
  }
  return {
    ...(diagnostics.length === 0 ? {} : { diagnostics }),
    ...(incomplete.length === 0 ? {} : { incomplete }),
    ...(truncated.length === 0 ? {} : { truncated }),
    ...(frame.instrumentationFailed ? { instrumentation_failure: true } : {}),
  };
};

const OMIT = Symbol("AmplioOmit");
const blockedDataKeys = new Set(["__proto__", "prototype", "constructor"]);
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_KEYS = 512;
const DEFAULT_MAX_STRING_BYTES = 8 * 1_024;
const DEFAULT_MAX_OCCURRENCE_BYTES = 16 * 1_024;

type NumericEventLimit =
  | "maxDepth"
  | "maxKeys"
  | "maxStringBytes"
  | "maxOccurrenceBytes"
  | "maxRecordBytes";

const eventLimit = (
  frame: EventFrame,
  key: NumericEventLimit,
  fallback: number,
): number => {
  const configured = frame.config.eventRuntime?.limits?.[key];
  return typeof configured === "number" &&
    Number.isFinite(configured) &&
    configured > 0
    ? Math.floor(configured)
    : fallback;
};

const truncateUtf8 = (
  value: string,
  maxBytes: number,
): { readonly value: string; readonly truncated: boolean } => {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }
  let bytes = 0;
  let output = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    output += character;
    bytes += characterBytes;
  }
  return { value: output, truncated: true };
};

const sanitizeValue = (
  frame: EventFrame,
  value: unknown,
  ancestors: object[],
  depth: number,
  path: SemanticPath = [],
): unknown | typeof OMIT => {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const bounded = truncateUtf8(
      value,
      eventLimit(frame, "maxStringBytes", DEFAULT_MAX_STRING_BYTES),
    );
    if (bounded.truncated) {
      addDiagnostic(frame, "value_string_truncated", path, frame.definition);
    }
    return bounded.value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return OMIT;
  if (depth >= eventLimit(frame, "maxDepth", DEFAULT_MAX_DEPTH)) {
    addDiagnostic(frame, "value_depth_exceeded", path, frame.definition);
    return OMIT;
  }

  const object = value as object;
  if (ancestors.includes(object)) return "[Circular]";
  try {
    if (value instanceof Date) {
      const time = value.getTime();
      return Number.isFinite(time) ? value.toISOString() : OMIT;
    }
  } catch {
    frame.instrumentationFailed = true;
    addDiagnostic(frame, "serialization_failed", [], frame.definition);
    return OMIT;
  }

  ancestors.push(object);
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    const maxKeys = eventLimit(frame, "maxKeys", DEFAULT_MAX_KEYS);
    const length = Math.min(value.length, maxKeys);
    if (value.length > maxKeys) {
      addDiagnostic(frame, "value_keys_truncated", path, frame.definition);
    }
    for (let index = 0; index < length; index += 1) {
      try {
        const item = sanitizeValue(
          frame,
          value[index],
          ancestors,
          depth + 1,
          [...path, index],
        );
        output.push(item === OMIT ? null : item);
      } catch {
        frame.instrumentationFailed = true;
        addDiagnostic(frame, "serialization_failed", [], frame.definition);
        output.push(null);
      }
    }
    ancestors.pop();
    return output;
  }

  let prototype: object | null;
  let keys: string[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    keys = Object.keys(value);
  } catch {
    ancestors.pop();
    frame.instrumentationFailed = true;
    addDiagnostic(frame, "serialization_failed", [], frame.definition);
    return OMIT;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    ancestors.pop();
    return OMIT;
  }

  const maxKeys = eventLimit(frame, "maxKeys", DEFAULT_MAX_KEYS);
  const ownedKeys = keys.filter((key) => !runtimeOwnedKeys.has(key));
  if (ownedKeys.length > maxKeys) {
    addDiagnostic(frame, "value_keys_truncated", path, frame.definition);
    const acceptedOwnedKeys = new Set(ownedKeys.slice(0, maxKeys));
    keys = keys.filter(
      (key) => runtimeOwnedKeys.has(key) || acceptedOwnedKeys.has(key),
    );
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (blockedDataKeys.has(key)) continue;
    try {
      const item = sanitizeValue(
        frame,
        (value as Record<string, unknown>)[key],
        ancestors,
        depth + 1,
        [...path, key],
      );
      if (item !== OMIT) output[key] = item;
    } catch {
      frame.instrumentationFailed = true;
      addDiagnostic(frame, "serialization_failed", [], frame.definition);
    }
  }
  ancestors.pop();
  return output;
};

const safePatch = (
  frame: EventFrame,
  project: (() => unknown) | undefined,
): Record<string, unknown> | undefined => {
  if (!project) return undefined;
  try {
    const value = project();
    let then: unknown;
    try {
      then =
        value !== null &&
        (typeof value === "object" || typeof value === "function")
          ? (value as { readonly then?: unknown }).then
          : undefined;
    } catch {
      then = undefined;
      frame.instrumentationFailed = true;
      addDiagnostic(frame, "projection_failed", [], frame.definition);
      return undefined;
    }
    if (typeof then === "function") {
      frame.instrumentationFailed = true;
      addDiagnostic(
        frame,
        "async_projection_unsupported",
        [],
        frame.definition,
      );
      void Promise.resolve(value).catch(() => undefined);
      return undefined;
    }
    const sanitized = sanitizeValue(frame, value, [], 0);
    if (!isObject(sanitized)) {
      frame.instrumentationFailed = true;
      addDiagnostic(frame, "projection_failed", [], frame.definition);
      return undefined;
    }
    const patch: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(sanitized)) {
      if (
        !runtimeOwnedKeys.has(key) &&
        !frame.ownKeys.has(key) &&
        entry !== undefined
      ) {
        patch[key] = entry;
      }
    }
    return patch;
  } catch {
    frame.instrumentationFailed = true;
    addDiagnostic(frame, "projection_failed", [], frame.definition);
    return undefined;
  }
};

const mergePatch = (
  frame: EventFrame,
  project: (() => unknown) | undefined,
): void => {
  const patch = safePatch(frame, project);
  if (!patch) return;
  try {
    frame.own = deepMerge(frame.own, patch);
  } catch {
    frame.instrumentationFailed = true;
    addDiagnostic(frame, "projection_failed", [], frame.definition);
  }
};

const builtInErrorTypes = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
]);
const TrustedErrorCode = Symbol("AmplioTrustedErrorCode");

const safeError = (error: unknown): StructuredError => {
  try {
    if (error instanceof Error) {
      const trustedCode = (
        error as Error & { readonly [TrustedErrorCode]?: unknown }
      )[TrustedErrorCode];
      return {
        type:
          typeof error.name === "string" && builtInErrorTypes.has(error.name)
            ? error.name
            : "Error",
        ...(typeof trustedCode === "string"
          ? { code: trustedCode }
          : {}),
      };
    }
  } catch {
    // Hostile application errors must not replace the original value.
  }
  return { type: "NonError" };
};

const isWireValue = (
  value: unknown,
  ancestors: object[] = [],
  depth = 0,
): boolean => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth >= 12) return false;
  if (ancestors.includes(value)) return false;
  ancestors.push(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 512) return false;
      return value.every((entry) => isWireValue(entry, ancestors, depth + 1));
    }
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      return false;
    }
    const keys = Object.keys(value);
    if (keys.length > 512 || keys.some((key) => blockedDataKeys.has(key))) {
      return false;
    }
    return keys.every((key) =>
      isWireValue(
        (value as Record<string, unknown>)[key],
        ancestors,
        depth + 1,
      ),
    );
  } catch {
    return false;
  } finally {
    ancestors.pop();
  }
};

const validateFrameOwn = (
  frame: EventFrame,
): Record<string, unknown> | undefined => {
  try {
    const result = frame.definition.schema["~standard"].validate(frame.own);
    let then: unknown;
    try {
      then =
        result !== null &&
        (typeof result === "object" || typeof result === "function")
          ? (result as { readonly then?: unknown }).then
          : undefined;
    } catch {
      then = undefined;
      frame.instrumentationFailed = true;
    }
    if (typeof then === "function") {
      void Promise.resolve(result).catch(() => undefined);
      frame.instrumentationFailed = true;
      addDiagnostic(frame, "async_schema_unsupported", [], frame.definition);
      return undefined;
    }
    const synchronous = result as SchemaResult<Record<string, unknown>>;
    if ("issues" in synchronous && synchronous.issues) {
      addDiagnostic(frame, "schema_validation_failed", [], frame.definition);
      return undefined;
    }
    if (!isWireValue(synchronous.value)) {
      addDiagnostic(frame, "schema_output_invalid", [], frame.definition);
      return undefined;
    }
    const sanitized = sanitizeValue(frame, synchronous.value, [], 0);
    if (!isObject(sanitized)) {
      addDiagnostic(frame, "schema_output_invalid", [], frame.definition);
      return undefined;
    }
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(sanitized)) {
      if (!runtimeOwnedKeys.has(key) && !frame.ownKeys.has(key)) {
        output[key] = value;
      }
    }
    return output;
  } catch {
    frame.instrumentationFailed = true;
    addDiagnostic(frame, "schema_validation_failed", [], frame.definition);
    return undefined;
  }
};

const finalizeFrame = (
  frame: EventFrame,
  success: boolean,
  error?: unknown,
): Record<string, unknown> | undefined => {
  if (frame.shadow) return undefined;
  closeFrame(frame);
  const output = validateFrameOwn(frame);
  if (!output) return;

  const value = {
    ...output,
    ...frame.children,
  };
  const snapshot = sanitizeValue(frame, value, [], 0);
  if (!isObject(snapshot)) return undefined;
  const metadata = operationalMetadata(frame);
  return {
    ...snapshot,
    ...(frame.definition.timing === "duration"
      ? {
          duration_ms: Date.now() - frame.startedAt,
          success,
          ...(error === undefined ? {} : { error: safeError(error) }),
        }
      : {}),
    ...(metadata ? { "@amplio": metadata } : {}),
  };
};

const hoistChildMetadata = (
  attachment: EventAttachment,
  value: Record<string, unknown>,
): Record<string, unknown> => {
  const metadata = value["@amplio"];
  if (!isObject(metadata)) return value;
  const parent = attachment.parent;
  const prefix = attachmentPath(attachment);

  for (const item of Array.isArray(metadata.truncated)
    ? metadata.truncated
    : []) {
    if (!isObject(item) || !Array.isArray(item.path)) continue;
    const path = [...prefix, ...(item.path as SemanticPath)];
    const key = JSON.stringify(path);
    const current = parent.truncations.get(key);
    if (typeof item.max === "number" && typeof item.dropped === "number") {
      parent.truncations.set(key, {
        path,
        max: item.max,
        dropped: (current?.dropped ?? 0) + item.dropped,
      });
    }
  }
  for (const item of Array.isArray(metadata.incomplete)
    ? metadata.incomplete
    : []) {
    if (!isObject(item) || !Array.isArray(item.path)) continue;
    const path = [...prefix, ...(item.path as SemanticPath)];
    const key = JSON.stringify(path);
    const current = parent.incompletes.get(key);
    if (typeof item.event === "string") {
      parent.incompletes.set(key, {
        path,
        event: item.event,
        pending:
          (current?.pending ?? 0) +
          (typeof item.pending === "number" ? item.pending : 1),
      });
    }
  }
  for (const item of Array.isArray(metadata.diagnostics)
    ? metadata.diagnostics
    : []) {
    if (!isObject(item) || !Array.isArray(item.path)) continue;
    const path = [...prefix, ...(item.path as SemanticPath)];
    const event =
      typeof item.event === "string"
        ? item.event
        : attachment.target.definition.id;
    const code =
      typeof item.code === "string" ? item.code : "instrumentation_failed";
    const key = `${code}:${JSON.stringify(path)}:${event}`;
    const current = parent.diagnostics.get(key);
    parent.diagnostics.set(key, {
      code,
      path,
      event,
      count:
        (current?.count ?? 0) +
        (typeof item.count === "number" ? item.count : 1),
    });
  }
  if (metadata.instrumentation_failure === true) {
    parent.instrumentationFailed = true;
  }
  const output = { ...value };
  delete output["@amplio"];
  return output;
};

const attachFinalized = (
  attachment: EventAttachment,
  value: Record<string, unknown> | undefined,
): void => {
  if (!attachment.accepted || attachment.settled) return;
  attachment.settled = true;
  const { parent, target } = attachment;
  parent.pending.delete(attachment);
  if (parent.closed) {
    reportDiagnostic(parent.config, {
      code: "observation_after_close",
      stage: "observation",
      event: target.definition.id,
    });
    return;
  }
  if (!value) {
    addDiagnostic(
      parent,
      "nested_event_dropped",
      attachmentPath(attachment),
      target.definition,
    );
    return;
  }
  try {
    const maxOccurrenceBytes = eventLimit(
      parent,
      "maxOccurrenceBytes",
      DEFAULT_MAX_OCCURRENCE_BYTES,
    );
    if (
      Buffer.byteLength(JSON.stringify(value), "utf8") > maxOccurrenceBytes
    ) {
      addDiagnostic(
        parent,
        "occurrence_oversize",
        attachmentPath(attachment),
        target.definition,
      );
      return;
    }
  } catch {
    addDiagnostic(
      parent,
      "occurrence_oversize",
      attachmentPath(attachment),
      target.definition,
    );
    return;
  }
  const attached = hoistChildMetadata(attachment, value);
  if (attachment.index === undefined) {
    setAtPath(parent.children, target.path, attached);
    return;
  }
  const values = getAtPath(parent.children, target.path);
  if (Array.isArray(values)) {
    values[attachment.index] = attached;
  }
};

const effectiveMaxDurationMs = (frame: EventFrame): number => {
  const configured = frame.config.eventRuntime?.limits?.maxEventDurationMs;
  return typeof configured === "number" &&
    Number.isFinite(configured) &&
    configured > 0
    ? Math.min(frame.definition.maxDurationMs, configured)
    : frame.definition.maxDurationMs;
};

const scheduleDeadline = (
  frame: EventFrame,
  expire: () => void,
): ReturnType<typeof setTimeout> => {
  const timer = setTimeout(expire, effectiveMaxDurationMs(frame));
  timer.unref?.();
  return timer;
};

const expireAttachment = (
  occurrence: EventFrame,
  attachment: EventAttachment,
): void => {
  if (attachment.settled) return;
  attachment.settled = true;
  attachment.parent.pending.delete(attachment);
  closeFrame(occurrence);
  if (!attachment.parent.closed && attachment.accepted) {
    addDiagnostic(
      attachment.parent,
      "event_timeout",
      attachmentPath(attachment),
      attachment.target.definition,
    );
  }
};

const sameSerializedValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => sameSerializedValue(entry, right[index]))
    );
  }
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => key in right && sameSerializedValue(left[key], right[key]),
    )
  );
};

const ownEventValue = (
  definition: EventDefinition,
  node: Record<string, unknown>,
): Record<string, unknown> => {
  const treeKeys = new Set(Object.keys(definition.tree));
  return Object.fromEntries(
    Object.entries(node).filter(
      ([key]) => !runtimeOwnedKeys.has(key) && !treeKeys.has(key),
    ),
  );
};

const validatesPostRedactionOwnValue = (
  frame: EventFrame,
  definition: EventDefinition,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): boolean => {
  if (sameSerializedValue(expected, actual)) return true;
  if (Object.keys(actual).some((key) => !(key in expected))) return false;

  try {
    const result = definition.schema["~standard"].validate(actual);
    let then: unknown;
    try {
      then =
        result !== null &&
        (typeof result === "object" || typeof result === "function")
          ? (result as { readonly then?: unknown }).then
          : undefined;
    } catch {
      return false;
    }
    if (typeof then === "function") {
      void Promise.resolve(result).catch(() => undefined);
      return false;
    }
    const synchronous = result as SchemaResult<Record<string, unknown>>;
    if ("issues" in synchronous && synchronous.issues) return false;
    const instrumentationBefore = frame.instrumentationFailed;
    const sanitized = sanitizeValue(frame, synchronous.value, [], 0);
    return (
      frame.instrumentationFailed === instrumentationBefore &&
      isObject(sanitized) &&
      sameSerializedValue(sanitized, actual)
    );
  } catch {
    return false;
  }
};

const validatesStructuredError = (
  expected: unknown,
  actual: unknown,
): boolean => {
  if (actual === undefined) return true;
  if (!isObject(expected) || !isObject(actual)) return false;
  if (actual.type !== expected.type || typeof actual.type !== "string") {
    return false;
  }
  return (
    Object.keys(actual).every(
      (key) =>
        key === "type" ||
        ((key === "code" || key === "message") &&
          typeof actual[key] === "string"),
    ) && Object.keys(actual).every((key) => key in expected)
  );
};

const validatesPostRedactionTree = (
  frame: EventFrame,
  tree: EventTree,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): boolean => {
  if (Object.keys(actual).some((key) => !(key in expected))) return false;
  for (const [key, mounted] of Object.entries(tree)) {
    const expectedValue = expected[key];
    const actualValue = actual[key];
    if (actualValue === undefined) continue;
    if (expectedValue === undefined) return false;

    if (isEventDefinition(mounted)) {
      if (mounted.cardinality === "single") {
        if (
          !isObject(expectedValue) ||
          !isObject(actualValue) ||
          !validatesPostRedactionNode(
            frame,
            mounted,
            expectedValue,
            actualValue,
          )
        ) {
          return false;
        }
        continue;
      }
      if (
        !Array.isArray(expectedValue) ||
        !Array.isArray(actualValue) ||
        expectedValue.length !== actualValue.length
      ) {
        return false;
      }
      if (
        actualValue.some(
          (entry, index) =>
            !isObject(entry) ||
            !isObject(expectedValue[index]) ||
            !validatesPostRedactionNode(
              frame,
              mounted,
              expectedValue[index],
              entry,
            ),
        )
      ) {
        return false;
      }
      continue;
    }

    if (
      !isObject(expectedValue) ||
      !isObject(actualValue) ||
      !validatesPostRedactionTree(frame, mounted, expectedValue, actualValue)
    ) {
      return false;
    }
  }
  return true;
};

const validatesPostRedactionNode = (
  frame: EventFrame,
  definition: EventDefinition,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): boolean => {
  if (sameSerializedValue(expected, actual)) return true;
  if (Object.keys(actual).some((key) => !(key in expected))) return false;
  if (
    definition.timing === "duration" &&
    (actual.duration_ms !== expected.duration_ms ||
      actual.success !== expected.success ||
      !validatesStructuredError(expected.error, actual.error))
  ) {
    return false;
  }
  return (
    validatesPostRedactionOwnValue(
      frame,
      definition,
      ownEventValue(definition, expected),
      ownEventValue(definition, actual),
    ) && validatesPostRedactionTree(frame, definition.tree, expected, actual)
  );
};

const validatesPostRedactionRecord = (
  frame: EventFrame,
  expected: LogRecord,
  actual: LogRecord,
): boolean => {
  if (sameSerializedValue(expected, actual)) return true;
  if (Object.keys(actual).some((key) => !(key in expected))) return false;
  if (
    actual["@event"] !== expected["@event"] ||
    actual["@event_version"] !== expected["@event_version"] ||
    actual.service !== expected.service ||
    actual.env !== expected.env ||
    actual.timestamp !== expected.timestamp ||
    actual.duration_ms !== expected.duration_ms ||
    actual.success !== expected.success ||
    !sameSerializedValue(actual["@amplio"], expected["@amplio"]) ||
    !validatesStructuredError(expected.error, actual.error)
  ) {
    return false;
  }
  if (actual.resource !== undefined) {
    const expectedResource = expected.resource;
    if (!isObject(expectedResource) || !isObject(actual.resource)) return false;
    if (
      Object.keys(actual.resource).some((key) => !(key in expectedResource))
    ) {
      return false;
    }
    const sanitizedResource = sanitizeResource(actual.resource);
    if (
      !sanitizedResource ||
      !sameSerializedValue(sanitizedResource, actual.resource)
    ) {
      return false;
    }
  }
  return validatesPostRedactionNode(frame, frame.definition, expected, actual);
};

const sanitizeResource = (value: unknown): ResourceAttributes | undefined => {
  if (!isObject(value)) return undefined;
  const output = Object.create(null) as Record<
    string,
    string | number | boolean
  >;
  let keys: string[];
  try {
    keys = Object.keys(value).slice(0, 64);
  } catch {
    return undefined;
  }
  for (const key of keys) {
    if (blockedDataKeys.has(key)) continue;
    try {
      const entry = value[key];
      if (
        typeof entry === "string" ||
        typeof entry === "boolean" ||
        (typeof entry === "number" && Number.isFinite(entry))
      ) {
        output[key] = typeof entry === "string" ? entry.slice(0, 1_024) : entry;
      }
    } catch {
      return undefined;
    }
  }
  return Object.freeze(output);
};

interface RecordReductionCandidate {
  readonly path: SemanticPath;
  readonly max: number;
  readonly remove: () => boolean;
}

const collectRecordReductionCandidates = (
  tree: EventTree,
  value: Record<string, unknown>,
  basePath: SemanticPath,
  repeated: RecordReductionCandidate[],
  singles: RecordReductionCandidate[],
): void => {
  for (const [key, mounted] of Object.entries(tree)) {
    const current = value[key];
    const path = [...basePath, key];
    if (!isEventDefinition(mounted)) {
      if (isObject(current)) {
        collectRecordReductionCandidates(
          mounted,
          current,
          path,
          repeated,
          singles,
        );
      }
      continue;
    }

    if (mounted.cardinality === "single") {
      if (!isObject(current)) continue;
      collectRecordReductionCandidates(
        mounted.tree,
        current,
        path,
        repeated,
        singles,
      );
      singles.push({
        path,
        max: 1,
        remove: () => {
          if (value[key] !== current) return false;
          delete value[key];
          return true;
        },
      });
      continue;
    }

    if (!Array.isArray(current)) continue;
    for (let index = 0; index < current.length; index += 1) {
      const occurrence = current[index];
      if (!isObject(occurrence)) continue;
      const occurrencePath = [...path, index];
      collectRecordReductionCandidates(
        mounted.tree,
        occurrence,
        occurrencePath,
        repeated,
        singles,
      );
      repeated.push({
        path,
        max: mounted.cardinality.many.max,
        remove: () => {
          const live = value[key];
          if (!Array.isArray(live)) return false;
          const liveIndex = live.indexOf(occurrence);
          if (liveIndex < 0) return false;
          live.splice(liveIndex, 1);
          if (live.length === 0) delete value[key];
          return true;
        },
      });
    }
  }
};

const pruneEmptyTreeGroups = (
  tree: EventTree,
  value: Record<string, unknown>,
): void => {
  for (const [key, mounted] of Object.entries(tree)) {
    const current = value[key];
    if (isEventDefinition(mounted)) {
      if (mounted.cardinality === "single" && isObject(current)) {
        pruneEmptyTreeGroups(mounted.tree, current);
      } else if (Array.isArray(current)) {
        for (const occurrence of current) {
          if (isObject(occurrence)) {
            pruneEmptyTreeGroups(mounted.tree, occurrence);
          }
        }
      }
      continue;
    }
    if (!isObject(current)) continue;
    pruneEmptyTreeGroups(mounted, current);
    if (Object.keys(current).length === 0) delete value[key];
  }
};

const recordBytes = (record: LogRecord): number => {
  try {
    return Buffer.byteLength(JSON.stringify(record), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const noteRecordReduction = (
  record: LogRecord,
  candidate: RecordReductionCandidate,
): void => {
  const currentMetadata = isObject(record["@amplio"])
    ? record["@amplio"]
    : {};
  const truncated = Array.isArray(currentMetadata.truncated)
    ? [...currentMetadata.truncated]
    : [];
  const existing = truncated.find(
    (entry) =>
      isObject(entry) &&
      Array.isArray(entry.path) &&
      sameSerializedValue(entry.path, candidate.path),
  );
  if (isObject(existing) && typeof existing.dropped === "number") {
    existing.dropped += 1;
  } else {
    truncated.push({
      path: [...candidate.path],
      max: candidate.max,
      dropped: 1,
    });
  }
  record["@amplio"] = {
    ...currentMetadata,
    truncated,
  } as LogRecord[string];
};

const compactDiagnosticDetails = (record: LogRecord): void => {
  const metadata = record["@amplio"];
  if (!isObject(metadata) || !Array.isArray(metadata.diagnostics)) return;
  const compact = new Map<string, { code: string; event: string; count: number }>();
  for (const entry of metadata.diagnostics) {
    if (!isObject(entry) || typeof entry.code !== "string") continue;
    const event = typeof entry.event === "string" ? entry.event : "unknown";
    const key = `${entry.code}:${event}`;
    const existing = compact.get(key);
    compact.set(key, {
      code: entry.code,
      event,
      count:
        (existing?.count ?? 0) +
        (typeof entry.count === "number" ? entry.count : 1),
    });
  }
  record["@amplio"] = {
    ...metadata,
    diagnostics: [...compact.values()],
  } as LogRecord[string];
};

const reduceRecordToLimit = (
  frame: EventFrame,
  record: LogRecord,
  maxBytes: number,
): boolean => {
  if (recordBytes(record) <= maxBytes) return true;
  const repeated: RecordReductionCandidate[] = [];
  const singles: RecordReductionCandidate[] = [];
  collectRecordReductionCandidates(
    frame.definition.tree,
    record,
    [],
    repeated,
    singles,
  );

  for (const candidate of [...repeated.reverse(), ...singles.reverse()]) {
    if (!candidate.remove()) continue;
    noteRecordReduction(record, candidate);
    pruneEmptyTreeGroups(frame.definition.tree, record);
    if (recordBytes(record) <= maxBytes) return true;
  }

  compactDiagnosticDetails(record);
  return recordBytes(record) <= maxBytes;
};

const deepFreeze = (value: unknown): void => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
};

const nullPrototypeClone = <Value>(value: Value): Value => {
  if (Array.isArray(value)) {
    return value.map((entry) => nullPrototypeClone(entry)) as Value;
  }
  if (value === null || typeof value !== "object") return value;
  const output = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) {
    output[key] = nullPrototypeClone(entry);
  }
  return output as Value;
};

const deliverFrame = (
  frame: EventFrame,
  success: boolean,
  error?: unknown,
): void => {
  const config = frame.config;
  if (!config.service || !config.env || config.sinks.length === 0) {
    closeFrame(frame);
    reportDiagnostic(config, {
      code: "runtime_not_initialized",
      stage: "configuration",
      event: frame.definition.id,
    });
    return;
  }

  const value = finalizeFrame(frame, success, error);
  if (!value) {
    reportDiagnostic(config, {
      code: "root_validation_failed",
      stage: "validation",
      event: frame.definition.id,
    });
    return;
  }
  const now = Date.now();
  let record = {
    ...value,
    "@event": frame.definition.id,
    "@event_version": frame.definition.version,
    service: config.service,
    env: config.env,
    timestamp: new Date(now).toISOString(),
  } as LogRecord;

  let resource: ResourceAttributes = Object.freeze({});
  for (const enricher of config.eventRuntime?.enrichers ?? []) {
    try {
      const next = enricher(resource);
      if (next !== undefined) {
        const sanitized = sanitizeResource(next);
        if (sanitized) resource = Object.freeze({ ...resource, ...sanitized });
      }
    } catch {
      reportDiagnostic(config, {
        code: "enricher_failed",
        stage: "enrichment",
        event: frame.definition.id,
      });
    }
  }
  if (Object.keys(resource).length > 0) {
    record = { ...record, resource: resource as LogRecord["resource"] };
  }
  const validationReference = structuredClone(record);

  const protectedEnvelope = Object.freeze({
    "@event": record["@event"],
    "@event_version": record["@event_version"],
    service: record.service,
    env: record.env,
    timestamp: record.timestamp,
    duration_ms: record.duration_ms,
    success: record.success,
    ...(record["@amplio"] === undefined
      ? {}
      : { "@amplio": record["@amplio"] }),
  });

  try {
    record = redactRecord(structuredClone(record), config.redact);
    if (config.eventRuntime?.redactor) {
      record = config.eventRuntime.redactor(
        structuredClone(record) as SinkRecord,
      ) as LogRecord;
    }
    const instrumentationBefore = frame.instrumentationFailed;
    const sanitized = sanitizeValue(frame, record, [], 0);
    if (
      !isObject(sanitized) ||
      frame.instrumentationFailed !== instrumentationBefore
    ) {
      throw new Error("redactor returned an unsafe record");
    }
    record = Object.assign(
      Object.create(null),
      sanitized,
      protectedEnvelope,
    ) as LogRecord;
  } catch {
    reportDiagnostic(config, {
      code: "redactor_failed",
      stage: "redaction",
      event: frame.definition.id,
    });
    return;
  }

  if (!validatesPostRedactionRecord(frame, validationReference, record)) {
    reportDiagnostic(config, {
      code: "post_redaction_validation_failed",
      stage: "validation",
      event: frame.definition.id,
    });
    return;
  }

  const maxRecordBytes = eventLimit(
    frame,
    "maxRecordBytes",
    256 * 1_024,
  );
  if (!reduceRecordToLimit(frame, record, maxRecordBytes)) {
    reportDiagnostic(config, {
      code: "record_oversize",
      stage: "serialization",
      event: frame.definition.id,
    });
    return;
  }

  if (config.eventRuntime?.sampler) {
    try {
      const samplerRecord = nullPrototypeClone(record);
      deepFreeze(samplerRecord);
      if (
        config.eventRuntime.sampler(samplerRecord as SinkRecord) !== true
      ) {
        return;
      }
    } catch {
      reportDiagnostic(config, {
        code: "sampler_failed",
        stage: "sampling",
        event: frame.definition.id,
      });
      return;
    }
  }
  if (!shouldSample(record, config.sampling)) return;

  let encoded: string;
  try {
    encoded = JSON.stringify(record);
  } catch {
    return;
  }
  if (Buffer.byteLength(encoded, "utf8") > maxRecordBytes) {
    reportDiagnostic(config, {
      code: "record_oversize",
      stage: "serialization",
      event: frame.definition.id,
    });
    return;
  }

  deepFreeze(record);
  for (const sink of new Set(config.sinks)) {
    const isolated = nullPrototypeClone(record);
    deepFreeze(isolated);
    deliveredRecordDefinitions.set(isolated, frame.definition);
    runSinksSync([sink], isolated, {
      maxPendingPerSink:
        config.eventRuntime?.delivery?.maxPendingPerSink ?? 1_024,
      generationId: config.eventRuntime?.deliveryGenerationId,
      onBackpressure: () =>
        reportDiagnostic(config, {
          code: "sink_backpressure_drop",
          stage: "delivery",
          event: frame.definition.id,
        }),
    });
  }
};

const reportInactiveObservation = (
  definition: EventDefinition,
  parent: EventFrame | undefined,
): void => {
  if (parent?.shadow) return;
  const config = parent?.config ?? resolveRuntimeConfig();
  reportDiagnostic(config, {
    code: !parent
      ? config.service
        ? "observation_outside_event"
        : "runtime_not_initialized"
      : parent.closed
        ? "observation_after_close"
        : "event_unmounted",
    stage: "observation",
    event: definition.id,
  });
};

/** @internal Used only by the Plugin authoring subpath. */
export function observeNestedEvent<
  E extends EventDefinition,
  F extends AnyFunction,
>(definition: E, fn: F, projectors?: EventProjectors<F, EventInput<E>>): F {
  const wrapped = function (
    this: ThisParameterType<F>,
    ...args: Parameters<F>
  ) {
    const parent = eventStorage.getStore();
    const target = parent?.targets.get(definition);
    if (!parent || parent.closed || parent.shadow || !target) {
      reportInactiveObservation(definition, parent);
      return fn.apply(this, args) as ReturnType<F>;
    }

    const attachment = reserveAttachment(parent, target);
    const occurrence = makeFrame(
      definition,
      parent.rootDefinition,
      !attachment.accepted,
      parent.config,
    );
    mergePatch(
      occurrence,
      projectors?.input && (() => projectors.input!({ args })),
    );
    let observationSettled = false;
    const deadline = scheduleDeadline(occurrence, () => {
      if (observationSettled) return;
      observationSettled = true;
      expireAttachment(occurrence, attachment);
    });

    const settleSuccess = (result: SettledResult<F>): void => {
      if (observationSettled) return;
      observationSettled = true;
      clearTimeout(deadline);
      try {
        mergePatch(
          occurrence,
          projectors?.result && (() => projectors.result!({ args, result })),
        );
        let success = true;
        if (projectors?.success) {
          try {
            const classified = projectors.success({ args, result });
            success = typeof classified === "boolean" ? classified : true;
          } catch {
            occurrence.instrumentationFailed = true;
            addDiagnostic(
              occurrence,
              "success_projection_failed",
              [],
              definition,
            );
          }
        }
        attachFinalized(attachment, finalizeFrame(occurrence, success));
      } catch {
        occurrence.instrumentationFailed = true;
        addDiagnostic(occurrence, "finalization_failed", [], definition);
        attachFinalized(attachment, undefined);
      }
    };

    const settleFailure = (error: unknown): void => {
      if (observationSettled) return;
      observationSettled = true;
      clearTimeout(deadline);
      try {
        mergePatch(
          occurrence,
          projectors?.error && (() => projectors.error!({ args, error })),
        );
        attachFinalized(attachment, finalizeFrame(occurrence, false, error));
      } catch {
        occurrence.instrumentationFailed = true;
        addDiagnostic(occurrence, "finalization_failed", [], definition);
        attachFinalized(attachment, undefined);
      }
    };

    try {
      const result = eventStorage.run(occurrence, () =>
        fn.apply(this, args),
      ) as ReturnType<F>;
      if (nodeTypes.isPromise(result)) {
        const attached = attachNativePromiseSettlement(
          result,
          (settled: unknown) => settleSuccess(settled as SettledResult<F>),
          settleFailure,
        );
        if (!attached) {
          observationSettled = true;
          clearTimeout(deadline);
          closeFrame(occurrence);
          attachment.settled = true;
          attachment.parent.pending.delete(attachment);
          attachment.parent.instrumentationFailed = true;
          addDiagnostic(
            attachment.parent,
            "promise_observation_failed",
            attachmentPath(attachment),
            definition,
          );
        }
        return result;
      }
      settleSuccess(result as SettledResult<F>);
      return result;
    } catch (error) {
      settleFailure(error);
      throw error;
    }
  };
  return wrapped as F;
}

/** @internal Used only by the Plugin authoring subpath. */
export function recordNestedEvent<E extends EventDefinition>(
  definition: E,
  value: EventInput<E>,
): void {
  if (definition.timing !== "instant") return;
  const parent = eventStorage.getStore();
  const target = parent?.targets.get(definition);
  if (!parent || parent.closed || parent.shadow || !target) {
    reportInactiveObservation(definition, parent);
    return;
  }

  const attachment = reserveAttachment(parent, target);
  if (!attachment.accepted) return;
  const occurrence = makeFrame(
    definition,
    parent.rootDefinition,
    false,
    parent.config,
  );
  mergePatch(occurrence, () => value);
  try {
    attachFinalized(attachment, finalizeFrame(occurrence, true));
  } catch {
    attachFinalized(attachment, undefined);
  }
}

const inertObservationHandle = <
  Node extends Record<string, unknown>,
>(): ObservationHandle<Node> => {
  const handle: ObservationHandle<Node> = {
    run<T>(fn: () => T): T {
      return fn();
    },
    bind<F extends AnyFunction>(fn: F): F {
      const bound = function (
        this: ThisParameterType<F>,
        ...args: Parameters<F>
      ) {
        return fn.apply(this, args) as ReturnType<F>;
      };
      return bound as F;
    },
    update() {},
    end() {},
    fail() {},
    cancel() {},
  };
  return handle;
};

/** @internal Used only by the Plugin authoring subpath. */
export function beginNestedEvent<E extends EventDefinition>(
  definition: E,
  input?: DeepPartial<EventInput<E>>,
): ObservationHandle<EventInput<E>> {
  if (definition.timing !== "duration") {
    return inertObservationHandle<EventInput<E>>();
  }
  const parent = eventStorage.getStore();
  const target = parent?.targets.get(definition);
  if (!parent || parent.closed || parent.shadow || !target) {
    reportInactiveObservation(definition, parent);
    return inertObservationHandle<EventInput<E>>();
  }

  const attachment = reserveAttachment(parent, target);
  const occurrence = makeFrame(
    definition,
    parent.rootDefinition,
    !attachment.accepted,
    parent.config,
  );
  mergePatch(occurrence, input && (() => input));
  let settled = false;
  const deadline = scheduleDeadline(occurrence, () => {
    if (settled) return;
    settled = true;
    expireAttachment(occurrence, attachment);
  });

  const handle: ObservationHandle<EventInput<E>> = {
    run<T>(fn: () => T): T {
      return eventStorage.run(occurrence, fn);
    },
    bind<F extends AnyFunction>(fn: F): F {
      const bound = function (
        this: ThisParameterType<F>,
        ...args: Parameters<F>
      ) {
        return handle.run(() => fn.apply(this, args)) as ReturnType<F>;
      };
      return bound as F;
    },
    update(value): void {
      if (settled) return;
      mergePatch(occurrence, () => value);
    },
    end(value, options): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      mergePatch(occurrence, value && (() => value));
      try {
        attachFinalized(
          attachment,
          finalizeFrame(occurrence, options?.success ?? true),
        );
      } catch {
        attachFinalized(attachment, undefined);
      }
    },
    fail(error, value): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      mergePatch(occurrence, value && (() => value));
      try {
        attachFinalized(attachment, finalizeFrame(occurrence, false, error));
      } catch {
        attachFinalized(attachment, undefined);
      }
    },
    cancel(reasonCode = "cancelled"): void {
      if (settled) return;
      const cancellation = Object.assign(
        new Error("Event observation cancelled"),
        {
          [TrustedErrorCode]: /^[a-z][a-z0-9_]{0,63}$/.test(reasonCode)
            ? reasonCode
            : "cancelled",
        },
      );
      handle.fail(cancellation);
    },
  };
  return handle;
}

/** @internal Exported publicly only through the Plugin authoring subpath. */
export function openRootEvent<
  E extends EventDefinition & { readonly timing: "duration" },
>(definition: E, input?: DeepPartial<EventInput<E>>): EventScope<E> {
  if (isDiagnosticContext()) {
    const inert: EventScope<E> = {
      run<T>(fn: () => T): T {
        return fn();
      },
      bind<F extends AnyFunction>(fn: F): F {
        return function (this: ThisParameterType<F>, ...args: Parameters<F>) {
          return fn.apply(this, args) as ReturnType<F>;
        } as F;
      },
      update() {},
      finish() {},
      fail() {},
      cancel() {},
    };
    return inert;
  }
  const frame = makeFrame(definition);
  mergePatch(frame, input && (() => input));
  let settled = false;
  const deadline = scheduleDeadline(frame, () => {
    if (settled) return;
    settled = true;
    closeFrame(frame);
    reportDiagnostic(frame.config, {
      code: "event_timeout",
      stage: "lifecycle",
      event: definition.id,
    });
  });

  const scope: EventScope<E> = {
    run<T>(fn: () => T): T {
      return eventStorage.run(frame, fn);
    },
    bind<F extends AnyFunction>(fn: F): F {
      const bound = function (
        this: ThisParameterType<F>,
        ...args: Parameters<F>
      ) {
        return scope.run(() => fn.apply(this, args)) as ReturnType<F>;
      };
      return bound as F;
    },
    update(value): void {
      if (settled) return;
      mergePatch(frame, () => value);
    },
    finish(value, options): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      mergePatch(frame, value && (() => value));
      try {
        deliverFrame(frame, options?.success ?? true);
      } catch {
        closeFrame(frame);
      }
    },
    fail(error, value): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      mergePatch(frame, value && (() => value));
      try {
        deliverFrame(frame, false, error);
      } catch {
        closeFrame(frame);
      }
    },
    cancel(reasonCode = "cancelled"): void {
      if (settled) return;
      const cancellation = Object.assign(new Error("Event scope cancelled"), {
        [TrustedErrorCode]: /^[a-z][a-z0-9_]{0,63}$/.test(reasonCode)
          ? reasonCode
          : "cancelled",
      });
      scope.fail(cancellation);
    },
  };
  return scope;
}

export function event<
  const Id extends string,
  const Version extends number,
  const S extends Schema,
  const Timing extends EventTiming = "duration",
  const Cardinality extends EventCardinality = "single",
  const Tree extends EventTree = {},
>(options: {
  id: Id;
  version: Version;
  schema: S & JsonSchemaContract<S>;
  timing?: Timing;
  cardinality?: Cardinality;
  maxDurationMs?: number;
  tree?: Tree;
}): EventDefinition<Id, Version, S, Timing, Cardinality, Tree> {
  if (!eventIdPattern.test(options.id)) {
    throw new Error(
      "event id must be lowercase dot-separated semantic segments",
    );
  }
  if (!Number.isInteger(options.version) || options.version <= 0) {
    throw new Error("event version must be a positive integer");
  }
  assertSchema(options.schema);
  const timing = options.timing ?? ("duration" as Timing);
  if (timing !== "instant" && timing !== "duration") {
    throw new Error('event timing must be "instant" or "duration"');
  }
  const cardinality = options.cardinality ?? ("single" as Cardinality);
  if (
    cardinality !== "single" &&
    (!Number.isFinite(cardinality.many.max) ||
      !Number.isInteger(cardinality.many.max) ||
      cardinality.many.max <= 0)
  ) {
    throw new Error("event cardinality max must be a positive integer");
  }
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  if (
    !Number.isFinite(maxDurationMs) ||
    !Number.isInteger(maxDurationMs) ||
    maxDurationMs <= 0
  ) {
    throw new Error("event maxDurationMs must be a positive finite integer");
  }
  const tree = normalizeEventTree(options.tree ?? {}) as Tree;
  if (timing === "instant" && Object.keys(tree).length > 0) {
    throw new Error("instant events cannot declare child events");
  }
  let definition!: EventDefinition<Id, Version, S, Timing, Cardinality, Tree>;
  const targets = compileTargets(tree);
  const handle = <F extends AnyFunction>(
    fn: F,
    projectors?: EventProjectors<F, SchemaInput<S>>,
  ): F => {
    const wrapped = function (
      this: ThisParameterType<F>,
      ...args: Parameters<F>
    ) {
      const active = eventStorage.getStore();
      if (isDiagnosticContext() || active?.rootDefinition === definition) {
        return fn.apply(this, args) as ReturnType<F>;
      }
      const frame = makeFrame(definition);
      mergePatch(
        frame,
        projectors?.input && (() => projectors.input!({ args })),
      );
      let lifecycleSettled = false;
      const deadline = scheduleDeadline(frame, () => {
        if (lifecycleSettled) return;
        lifecycleSettled = true;
        closeFrame(frame);
        reportDiagnostic(frame.config, {
          code: "event_timeout",
          stage: "lifecycle",
          event: definition.id,
        });
      });

      const settleSuccess = (settled: SettledResult<F>): void => {
        if (lifecycleSettled) return;
        lifecycleSettled = true;
        clearTimeout(deadline);
        try {
          mergePatch(
            frame,
            projectors?.result &&
              (() => projectors.result!({ args, result: settled })),
          );
          let success = true;
          if (projectors?.success) {
            try {
              const classified = projectors.success({
                args,
                result: settled,
              });
              success = typeof classified === "boolean" ? classified : true;
            } catch {
              frame.instrumentationFailed = true;
              addDiagnostic(frame, "success_projection_failed", [], definition);
            }
          }
          deliverFrame(frame, success);
        } catch {
          closeFrame(frame);
        }
      };

      const settleFailure = (error: unknown): void => {
        if (lifecycleSettled) return;
        lifecycleSettled = true;
        clearTimeout(deadline);
        try {
          mergePatch(
            frame,
            projectors?.error && (() => projectors.error!({ args, error })),
          );
          deliverFrame(frame, false, error);
        } catch {
          closeFrame(frame);
        }
      };

      return eventStorage.run(frame, () => {
        try {
          const result = fn.apply(this, args) as ReturnType<F>;
          if (nodeTypes.isPromise(result)) {
            const attached = attachNativePromiseSettlement(
              result,
              (settled: unknown) =>
                settleSuccess(settled as SettledResult<F>),
              settleFailure,
            );
            if (!attached) {
              lifecycleSettled = true;
              clearTimeout(deadline);
              closeFrame(frame);
              reportDiagnostic(frame.config, {
                code: "promise_observation_failed",
                stage: "lifecycle",
                event: definition.id,
              });
            }
            return result;
          }
          settleSuccess(result as SettledResult<F>);
          return result;
        } catch (error) {
          settleFailure(error);
          throw error;
        }
      });
    };
    return wrapped as F;
  };

  const definitionObject: Record<PropertyKey, unknown> = {
    id: options.id,
    version: options.version,
    schema: options.schema,
    timing,
    cardinality,
    maxDurationMs,
    tree,
  };
  Object.defineProperty(definitionObject, EventIdentity, {
    value: Object.freeze({
      input: undefined,
      output: undefined,
      timing,
      cardinality,
      tree,
    }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  if (timing === "duration") {
    definitionObject.handle = handle;
  }
  definition = definitionObject as EventDefinition<
    Id,
    Version,
    S,
    Timing,
    Cardinality,
    Tree
  >;
  eventDefinitions.add(definitionObject);
  definitionMetadata.set(definition, {
    targets,
    ownKeys: new Set(Object.keys(tree)),
  });
  return Object.freeze(definitionObject) as typeof definition;
}
