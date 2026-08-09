export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [P in keyof T]?: DeepPartial<T[P]> }
    : T;

export type LogRecord = Record<string, JsonValue>;

export interface StandardSchemaResult<T> {
  value?: T;
  issues?: readonly { message: string; path?: readonly PropertyKey[] }[];
}

export interface StandardSchemaV1<TInput = unknown, TOutput = TInput> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardSchemaResult<TOutput>;
    readonly types?: { readonly input: TInput; readonly output: TOutput };
  };
}

export interface ZodLikeSchema<T = unknown> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown };
}

export type EventShape<T extends Record<string, unknown> = Record<string, unknown>> =
  | StandardSchemaV1<T>
  | ZodLikeSchema<T>
  | undefined;

export interface DefineEventOptions {
  skipValidation?: boolean;
}

export interface EventDef<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly name: string;
  readonly shape: EventShape<T>;
  readonly skipValidation: boolean;
}

export interface StructuredError {
  message: string;
  name?: string;
  why?: string;
  fix?: string;
  code?: string;
  link?: string;
}

export type Sink = (record: LogRecord) => void | Promise<void>;

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

export interface AmplioConfig {
  service: string;
  env: string;
  sinks: Sink[];
  enrichers?: Enricher[];
  sampling?: SamplingConfig;
  redact?: RedactConfig;
  /** When true, schema validation failures throw from emit() even outside NODE_ENV=test. */
  strict?: boolean;
  /** When true, emitted records carry only the canonical @event key; the duplicate event key is removed at emit time. */
  canonicalKeyOnly?: boolean;
}

export interface RequestLoggerOptions {
  method: string;
  path: string;
  requestId?: string;
}

export interface Logger {
  readonly sealed: boolean;
  set(partial: Record<string, unknown>): Logger;
  error(err: unknown, ctx?: Record<string, unknown>): Logger;
  emit(): LogRecord | null;
  create(initial?: Record<string, unknown>): Logger;
  event<T extends Record<string, unknown>>(def: EventDef<T>): EventLogger<T>;
  child<T extends Record<string, unknown>>(def: EventDef<T>): EventLogger<T>;
}

export interface EventLogger<T extends Record<string, unknown>> {
  readonly sealed: boolean;
  set(partial: DeepPartial<T>): EventLogger<T>;
  error(err: unknown, ctx?: Record<string, unknown>): EventLogger<T>;
  emit(): LogRecord | null;
}
