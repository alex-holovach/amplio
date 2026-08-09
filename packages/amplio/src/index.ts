export { defineEvent } from "./define-event.js";
export {
  init,
  getConfig,
  isInitialized,
  resetConfigForTests,
  resetEmitBeforeInitWarningForTests,
} from "./config.js";
export { createLogger, logger } from "./logger.js";
export type { LoggerFacade } from "./logger.js";
export { createRequestLogger } from "./request-logger.js";
export {
  runWithLogger,
  useLogger,
  hasAmbientLogger,
  resetUseLoggerOutsideScopeWarningForTests,
} from "./context.js";
export { createError } from "./error.js";
export { deepMerge } from "./deep-merge.js";
export { redactRecord } from "./redact.js";
export { shouldSample } from "./sampling.js";
export { flush, runSinks, runSinksSync } from "./sinks.js";
export { scheduleFlush, resetScheduleFlushWarningForTests } from "./schedule-flush.js";
export type { ScheduleFlushOptions } from "./schedule-flush.js";
export { trpcErrorHttpStatus } from "./trpc-status.js";
export { validateShape } from "./schema.js";
export { AmplioValidationError } from "./validation-error.js";
export type { AmplioValidationIssue } from "./validation-error.js";
export { createRequestId } from "./request-id.js";

export type {
  DeepPartial,
  DefineEventOptions,
  Enricher,
  EventDef,
  EventLogger,
  EventShape,
  JsonPrimitive,
  JsonValue,
  KeepRule,
  LogRecord,
  AmplioConfig,
  Logger,
  RedactConfig,
  RequestLoggerOptions,
  SamplingConfig,
  Sink,
  StandardSchemaResult,
  StandardSchemaV1,
  StructuredError,
  ZodLikeSchema,
} from "./types.js";

