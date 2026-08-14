export type {
  AmplioConfig,
  DeepPartial,
  Enricher,
  EventShape,
  JsonPrimitive,
  JsonValue,
  KeepRule,
  LogRecord,
  RedactConfig,
  SamplingConfig,
  LegacySink as Sink,
  StructuredError,
  SyncStandardSchemaPathSegment,
  SyncStandardSchemaResult,
  SyncStandardSchemaV1,
  ZodLikeSchema,
} from "./semantic-types.js";

import type { DeepPartial, EventShape, LogRecord } from "./semantic-types.js";

export interface DefineEventOptions {
  skipValidation?: boolean;
}

export interface EventDef<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly name: string;
  readonly shape: EventShape<T>;
  readonly skipValidation: boolean;
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
  /**
   * Timed correlated row: creates a `.child(def)` before running fn and emits
   * it after fn settles, so duration_ms measures fn. On throw the child
   * records the error (success: false) and the error is rethrown.
   */
  time<T extends Record<string, unknown>, R>(
    def: EventDef<T>,
    fn: (ev: EventLogger<T>) => R | Promise<R>,
  ): Promise<R>;
}

export interface EventLogger<T extends Record<string, unknown>> {
  readonly sealed: boolean;
  set(partial: DeepPartial<T>): EventLogger<T>;
  error(err: unknown, ctx?: Record<string, unknown>): EventLogger<T>;
  emit(): LogRecord | null;
}
