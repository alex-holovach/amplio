export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

type MutableJsonValue =
  | JsonPrimitive
  | MutableJsonValue[]
  | { [key: string]: MutableJsonValue };

export type LogRecord = Record<string, MutableJsonValue>;

export type SinkRecord = Readonly<{
  "@event": string;
  "@event_version": number;
  service: string;
  env: string;
  timestamp: string;
  duration_ms: number;
  success: boolean;
  [key: string]: JsonValue;
}>;

export type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [P in keyof T]?: DeepPartial<T[P]> }
    : T;

export interface StructuredError {
  message: string;
  name?: string;
  why?: string;
  fix?: string;
  code?: string;
  link?: string;
}

export type SyncStandardSchemaPathSegment =
  PropertyKey | { readonly key: PropertyKey };

export interface SyncStandardSchemaResult<T> {
  value?: T;
  issues?: readonly {
    message: string;
    path?: readonly SyncStandardSchemaPathSegment[];
  }[];
}

/** The synchronous subset of Standard Schema v1 required by exact sync wrappers. */
export interface SyncStandardSchemaV1<TInput = unknown, TOutput = TInput> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => SyncStandardSchemaResult<TOutput>;
    readonly types?: { readonly input: TInput; readonly output: TOutput };
  };
}

export interface ZodLikeSchema<T = unknown> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: unknown };
}

export type EventShape<
  T extends Record<string, unknown> = Record<string, unknown>,
> = SyncStandardSchemaV1<T> | ZodLikeSchema<T> | undefined;

export type Sink = ((record: SinkRecord) => void | PromiseLike<void>) & {
  flush?: () => void | PromiseLike<void>;
};
export type LegacySink = ((record: LogRecord) => void | PromiseLike<void>) & {
  flush?: () => void | PromiseLike<void>;
};

export type Enricher = (record: LogRecord) => LogRecord;

export interface KeepRule {
  field: string;
  equals?: JsonValue;
  matches?: RegExp;
  gte?: number;
  lte?: number;
}

export interface SamplingConfig {
  rate?: number;
  keep?: KeepRule[];
}

export type RedactConfig = { fields?: string[]; patterns?: RegExp[] } | false;

export type ResourceAttribute = string | number | boolean;
export type ResourceAttributes = Readonly<Record<string, ResourceAttribute>>;

export interface RuntimeDiagnostic {
  readonly code: string;
  readonly stage?: string;
  readonly event?: string;
  readonly count?: number;
}

export type ResourceEnricher = (
  current: ResourceAttributes,
) => ResourceAttributes | undefined;
export type EventRedactor = (record: SinkRecord) => SinkRecord;
export type EventSampler = (record: SinkRecord) => boolean;

export interface EventLimits {
  maxEventDurationMs?: number;
  maxDepth?: number;
  maxKeys?: number;
  maxStringBytes?: number;
  maxOccurrenceBytes?: number;
  maxRecordBytes?: number;
}

export interface DeliveryOptions {
  maxPendingPerSink?: number;
  flushTimeoutMs?: number;
  maxRetiredGenerations?: number;
  retiredGenerationTtlMs?: number;
}

export interface FlushOptions {
  timeoutMs?: number;
}

export interface FlushResult {
  completed: number;
  pending: number;
  failures: number;
}

export interface EventRuntimeOptions {
  enrichers?: ResourceEnricher[];
  redactor?: EventRedactor;
  sampler?: EventSampler;
  onDiagnostic?: (diagnostic: RuntimeDiagnostic) => void | PromiseLike<void>;
  limits?: EventLimits;
  delivery?: DeliveryOptions;
  /** @internal Immutable delivery generation captured by open root Events. */
  deliveryGenerationId?: number;
}

export interface InitOptions {
  service: string;
  env: string;
  sinks: Sink[];
  enrichers?: ResourceEnricher[];
  redactor?: EventRedactor;
  sampler?: EventSampler;
  sampling?: SamplingConfig;
  redact?: RedactConfig;
  onDiagnostic?: (diagnostic: RuntimeDiagnostic) => void | PromiseLike<void>;
  limits?: EventLimits;
  delivery?: DeliveryOptions;
}

export interface AmplioConfig {
  service: string;
  env: string;
  sinks: LegacySink[];
  enrichers?: Enricher[];
  sampling?: SamplingConfig;
  redact?: RedactConfig;
  /** When true, schema validation failures throw after otherwise successful work. */
  strict?: boolean;
  /** When true, delivered records carry only the canonical @event key. */
  canonicalKeyOnly?: boolean;
  /** @internal Event-only runtime configuration carried with the active generation. */
  eventRuntime?: EventRuntimeOptions;
}
